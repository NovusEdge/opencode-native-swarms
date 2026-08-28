import { randomUUID } from "node:crypto"
import { topologicalReadySteps, transitionStep, transitionWorkflow } from "./planner"
import { cleanupWorkspace, type WorkspaceAdapters, type WorkspaceResult } from "./workspace"
import type { ApprovalSummary, CleanupResult, LaunchApproval, RunRecord, SessionAdapter, SessionMessage, StepRecord, WorkflowPlan, WorkflowStep, WorkflowState, OutputValue } from "./types"
import type { RepositoryStateStore } from "./state"

export const RESERVED_AGENT = "native-swarms-workflow-step"
const BUILTIN_TOOLS = new Set(["bash", "read", "edit", "grep", "webfetch", "task", "external_directory"])

export type StepBinding = Readonly<{ runId: string; stepId: string; sessionID: string; policyHash: string; workspace?: WorkspaceResult }>
export type ReservedAgent = Readonly<{ name?: string; definition: unknown; permissions?: unknown; tools?: readonly string[] }>
export type RuntimeOptions = Readonly<{
  state: RepositoryStateStore
  sessions: SessionAdapter
  repositoryRoot?: string
  repositoryId?: string
  workspace?: WorkspaceAdapters & Readonly<{ resolve?: (step: WorkflowStep) => Promise<WorkspaceResult> }>
  agent?: ReservedAgent
  now?: () => number
  event?: Readonly<{ subscribe?: (listener: (event: unknown) => void) => (() => void) | Promise<() => void> }>
  amend?: (runId: string, input: unknown) => Promise<Readonly<{ plan: WorkflowPlan; summary: ApprovalSummary }>>
  revalidate?: (runId: string, plan?: WorkflowPlan) => Promise<void>
}>
export type WorkflowRuntime = Readonly<{
  launch(plan: WorkflowPlan, approval: LaunchApproval): Promise<{ runId: string }>
  status(runId: string): Promise<RunRecord>
  wait(runId: string, timeoutMs: number): Promise<RunRecord & Readonly<{ timedOut?: boolean }>>
  cancel(runId: string): Promise<RunRecord>
  amend(runId: string, input: unknown): Promise<{ revision: number; approval: ApprovalSummary }>
  resume(runId: string, approval: LaunchApproval): Promise<RunRecord>
  cleanup(runId: string): Promise<CleanupResult>
  binding(sessionID: string): StepBinding | undefined
  beforeTool(sessionID: string, tool: string): void
}>

const terminal = (state: WorkflowState) => ["succeeded", "failed", "cancelled", "stale"].includes(state)
const iso = (now: () => number) => new Date(now()).toISOString()
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
function outputFromMessages(messages: readonly SessionMessage[], step: WorkflowStep): Readonly<Record<string, OutputValue>> {
  const parts = messages.flatMap((m) => [...m.parts])
  const candidate = parts.reverse().map((p: any) => p?.output ?? p?.data ?? p?.text ?? p).map((p: unknown) => {
    if (typeof p !== "string") return p
    try { return JSON.parse(p) } catch { return p }
  }).find((p: unknown) => p && typeof p === "object")
  if (!candidate) throw new Error(`Step ${step.id} returned no structured output`)
  const result: Record<string, OutputValue> = {}
  for (const declaration of step.outputs) {
    const value = (candidate as any)[declaration.name]
    if (value === undefined) { if (declaration.required) throw new Error(`Missing required output: ${step.id}.${declaration.name}`); continue }
    const type = Array.isArray(value) ? "json" : value === null ? "json" : typeof value === "string" ? (declaration.type === "markdown" || declaration.type === "text" ? declaration.type : "text") : typeof value
    if (declaration.type !== type && !(declaration.type === "json" && typeof value === "object")) throw new Error(`Invalid output type: ${step.id}.${declaration.name}`)
    result[declaration.name] = { type: declaration.type, value }
  }
  return result
}

function agentMatches(agent?: ReservedAgent): boolean {
  if (!agent || (agent.name && agent.name !== RESERVED_AGENT)) return false
  const value: any = agent.definition
  if (!value || typeof value !== "object") return false
  const permissions = value.permission ?? value.permissions
  const tools = agent.tools ?? value.tools
  if (!permissions || !tools || !Array.isArray(tools)) return false
  // Any built-in authority is unsafe, and workflow_command must be the only tool.
  if (tools.some((tool: unknown) => tool !== "workflow_command")) return false
  for (const name of [...BUILTIN_TOOLS]) {
    const permission = permissions[name]
    if (permission !== undefined && permission !== "deny" && !(permission && permission["*"] === "deny")) return false
  }
  return true
}

export function createWorkflowRuntime(options: RuntimeOptions): WorkflowRuntime {
  const now = options.now ?? Date.now
  const bindings = new Map<string, StepBinding>()
  const active = new Map<string, Set<string>>()
  const cancelled = new Set<string>()
  const plans = new Map<string, WorkflowPlan>()
  const signals = new Map<string, Set<() => void>>()
  const wake = (runId: string) => { for (const fn of signals.get(runId) ?? []) fn() }

  const get = async (runId: string) => { const record = await options.state.read(runId); if (!record) throw new Error("Run absent"); return record }
  const update = async (runId: string, fn: (record: RunRecord) => RunRecord) => {
    const record = await get(runId); const next = fn(record); await options.state.write(runId, next); wake(runId); return next
  }
  const failStep = async (runId: string, stepId: string, reason: string) => update(runId, (r) => ({ ...r, steps: r.steps.map((s) => s.id === stepId ? { ...s, state: "failed", failure: reason, finishedAt: iso(now) } : s), updatedAt: iso(now) }))
  const schedule = async (runId: string): Promise<void> => {
    let record = await get(runId), plan = plans.get(runId)
    if (!plan || terminal(record.state) || cancelled.has(runId)) return
    while (!terminal(record.state) && !cancelled.has(runId)) {
      const ready = topologicalReadySteps(plan, record.steps).filter((step) => !record.steps.some((s) => s.id === step.id && s.state !== "queued"))
      const capacity = plan.maxConcurrency - (active.get(runId)?.size ?? 0)
      for (const step of ready.slice(0, Math.max(0, capacity))) {
        await update(runId, (r) => ({ ...r, steps: r.steps.map((s) => s.id === step.id ? { ...s, state: "ready" } : s), updatedAt: iso(now) }))
        void execute(runId, plan, step).catch(async (e) => { await failStep(runId, step.id, errorText(e)); wake(runId) })
      }
      record = await get(runId)
      const anyActive = (active.get(runId)?.size ?? 0) > 0
      const failed = record.steps.some((s) => s.state === "failed")
      if (failed && plan.definition.failurePolicy === "fail-fast") { cancelled.add(runId); for (const id of active.get(runId) ?? []) await options.sessions.abort(id).catch(() => {}); record = await update(runId, (r) => ({ ...r, state: "failed", updatedAt: iso(now) })); break }
      const byId = new Map(plan.steps.map((s) => [s.id, s]))
      const blocked = record.steps.filter((s) => s.state === "queued" && (byId.get(s.id)?.dependsOn ?? []).some((dep) => record.steps.find((p) => p.id === dep)?.state !== "succeeded"))
      if (blocked.length && plan.definition.failurePolicy === "continue-independent") {
        for (const item of blocked) {
          const dependencyFailed = (byId.get(item.id)?.dependsOn ?? []).some((dep) => { const state = record.steps.find((p) => p.id === dep)?.state; return state === "failed" || state === "skipped" || state === "cancelled" })
          if (dependencyFailed) await update(runId, (r) => ({ ...r, steps: r.steps.map((s) => s.id === item.id ? { ...s, state: "skipped", failure: "Dependency did not succeed", finishedAt: iso(now) } : s), updatedAt: iso(now) }))
        }
        record = await get(runId)
      }
      const unresolved = record.steps.some((s) => s.state === "queued")
      if (!anyActive && !ready.length && !unresolved) { const state = failed ? "failed" : "succeeded"; if (!terminal(record.state)) record = await update(runId, (r) => ({ ...r, state, updatedAt: iso(now) })); break }
      if (!anyActive) break
      return
    }
  }
  async function execute(runId: string, plan: WorkflowPlan, step: WorkflowStep) {
    // Session creation is intentionally outside the scheduler's critical path.
    const workspace = options.workspace?.resolve ? await options.workspace.resolve(step) : undefined
    const session = await options.sessions.create({ directory: workspace?.path ?? options.repositoryRoot ?? ".", title: `${plan.definition.name}:${step.id}` })
    const binding = { runId, stepId: step.id, sessionID: session.sessionID, policyHash: plan.policyHash, workspace }
    bindings.set(session.sessionID, binding); const set = active.get(runId) ?? new Set<string>(); set.add(session.sessionID); active.set(runId, set)
    await update(runId, (r) => ({ ...r, steps: r.steps.map((s) => s.id === step.id ? { ...s, state: "running", sessionID: session.sessionID, startedAt: iso(now) } : s), updatedAt: iso(now) }))
    try {
      const current = await get(runId)
      const inputs = step.inputs.map((input) => ({ ...input, value: current.steps.find((s) => s.id === input.step)?.outputs?.[input.output] }))
      await options.sessions.promptAsync({ sessionID: session.sessionID, agent: RESERVED_AGENT, model: step.model.mode === "alias" ? step.model.alias : undefined, system: JSON.stringify({ step: step.id, policyHash: plan.policyHash, inputs, outputs: step.outputs, tools: ["workflow_command"], limits: step.limits }), tools: ["workflow_command"], parts: [{ type: "text", text: step.prompt }] })
      const status = await options.sessions.status(session.sessionID)
      if (status.type === "running") throw new Error("Session did not complete")
      if (status.type !== "completed") throw new Error(status.error ?? "Session failed")
      const outputs = outputFromMessages(await options.sessions.messages(session.sessionID), step)
      await update(runId, (r) => ({ ...r, steps: r.steps.map((s) => s.id === step.id ? { ...s, state: "succeeded", outputs, finishedAt: iso(now) } : s), updatedAt: iso(now) }))
      const after = await get(runId)
      if (after.steps.every((s) => s.state === "succeeded" || s.state === "skipped") && !terminal(after.state)) await update(runId, (r) => ({ ...r, state: "succeeded", updatedAt: iso(now) }))
    } catch (e) { await failStep(runId, step.id, errorText(e)) }
    finally { set.delete(session.sessionID); bindings.delete(session.sessionID); wake(runId); await schedule(runId) }
  }
  const launch = async (plan: WorkflowPlan, approval: LaunchApproval) => {
    if (!agentMatches(options.agent)) throw new Error("Reserved workflow agent is unavailable or mismatched")
    if (approval.workflowHash !== plan.workflowHash || approval.policyHash !== plan.policyHash || !approval.singleUse) throw new Error("Launch approval does not match plan")
    const runId = randomUUID(), timestamp = iso(now)
    const record: RunRecord = { runId, workflowName: plan.definition.name, revision: 1, workflowHash: plan.workflowHash, state: "running", createdAt: timestamp, updatedAt: timestamp, steps: plan.steps.map((s) => ({ id: s.id, state: "queued" })), policyHash: plan.policyHash }
    await options.state.write(runId, record); plans.set(runId, plan); active.set(runId, new Set()); void schedule(runId).catch(async (e) => { await update(runId, (r) => ({ ...r, state: "failed", updatedAt: iso(now), failure: errorText(e) } as any)) }); return { runId }
  }
  const status = get
  const wait = async (runId: string, timeoutMs: number) => { const initial = await get(runId); if (terminal(initial.state)) return initial; const result = await new Promise<RunRecord>((resolve) => { let done = false; const finish = async () => { if (!done) { done = true; clearTimeout(timer); signals.get(runId)?.delete(finish); resolve(await get(runId)) } }; const timer = setTimeout(finish, Math.max(0, timeoutMs)); const list = signals.get(runId) ?? new Set(); list.add(finish); signals.set(runId, list) }); return terminal(result.state) ? result : { ...result, timedOut: true } }
  const cancel = async (runId: string) => { cancelled.add(runId); const r = await get(runId); for (const session of active.get(runId) ?? []) await options.sessions.abort(session).catch(() => {}); return update(runId, (x) => x.state === "running" ? { ...x, state: "cancelled", steps: x.steps.map((s) => s.state === "queued" || s.state === "ready" ? { ...s, state: "cancelled" } : s), updatedAt: iso(now) } : x) }
  const amend = async (runId: string, input: unknown) => { if (!options.amend) throw new Error("Amendment adapter unavailable"); const current = await get(runId), result = await options.amend(runId, input); const revision = current.revision + 1; plans.set(runId, result.plan); await update(runId, (r) => ({ ...r, revision, workflowHash: result.plan.workflowHash, policyHash: result.plan.policyHash, state: "awaiting-approval", updatedAt: iso(now) })); return { revision, approval: result.summary } }
  const resume = async (runId: string, approval: LaunchApproval) => { const current = await get(runId), plan = plans.get(runId); if (!plan || approval.workflowHash !== current.workflowHash || approval.policyHash !== current.policyHash) throw new Error("Resume approval does not match run"); if (options.revalidate) await options.revalidate(runId, plan); await options.state.resume(runId, { revision: current.revision, policyHash: current.policyHash }); await update(runId, (r) => ({ ...r, state: "running", updatedAt: iso(now) })); cancelled.delete(runId); void schedule(runId); return get(runId) }
  const cleanup = async (runId: string) => { const r = await get(runId), workspaces = (r as any).workspaces as readonly WorkspaceResult[] | undefined; if (!workspaces?.length || !options.workspace) return { cleaned: false, reason: "Workspace evidence unavailable" } as CleanupResult; let result: CleanupResult = { cleaned: true }; for (const workspace of workspaces) { const next = await cleanupWorkspace({ ...workspace, failed: r.state === "failed", cancelled: r.state === "cancelled" }, options.workspace); if (!next.cleaned) return next; result = next } return result }
  return { launch, status, wait, cancel, amend, resume, cleanup, binding: (id) => bindings.get(id), beforeTool: (id, tool) => { if (!bindings.has(id)) throw new Error("Unbound workflow session"); if (BUILTIN_TOOLS.has(tool)) throw new Error("Built-in tool denied for workflow session") } }
}

export const createRuntime = createWorkflowRuntime
