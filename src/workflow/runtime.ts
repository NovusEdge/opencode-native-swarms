import { randomUUID, createHash } from "node:crypto"
import { topologicalReadySteps, transitionStep, transitionWorkflow } from "./planner"
import { cleanupWorkspace, type WorkspaceAdapters, type WorkspaceResult } from "./workspace"
import type { ApprovalSummary, CleanupResult, LaunchApproval, RunRecord, SessionAdapter, SessionMessage, StepRecord, WorkflowPlan, WorkflowStep, WorkflowState, OutputValue } from "./types"
import type { RepositoryStateStore } from "./state"

export const RESERVED_AGENT = "native-swarms-workflow-step"
const reservedAgentDefinition = { description: "Run one approved workflow step with no built-in tools.", mode: "subagent", color: "#777777", permission: { "*": "deny", workflow_command: "allow" }, tools: { workflow_command: true }, prompt: "Execute only the approved workflow step and return its declared structured outputs." }
const stable = (v: any): string => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v)
const RESERVED_AGENT_HASH = createHash("sha256").update(stable(reservedAgentDefinition)).digest("hex")
const BUILTIN_TOOLS = new Set(["bash", "read", "edit", "grep", "webfetch", "task", "external_directory"])

export type StepBinding = Readonly<{ runId: string; stepId: string; sessionID: string; policyHash: string; workspace?: WorkspaceResult }>
export type ReservedAgent = Readonly<{ name?: string; definition: unknown; permissions?: unknown; tools?: readonly string[] | Readonly<Record<string, boolean>> }>
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
  registerToolHook?: (hook: (input: { sessionID: string; tool: string }) => void) => void
  consumeApproval?: (token: string, workflowHash: string, policyHash: string) => Promise<boolean> | boolean
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
  if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > step.limits.maxOutputBytes) throw new Error(`Output exceeds limit: ${step.id}`)
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
  if (!permissions || !tools || (Array.isArray(tools) ? false : typeof tools !== "object")) return false
  if (createHash("sha256").update(stable(value)).digest("hex") !== RESERVED_AGENT_HASH) return false
  // Any built-in authority is unsafe, and workflow_command must be the only tool.
  const names = Array.isArray(tools) ? tools : Object.entries(tools).filter(([, enabled]) => enabled).map(([name]) => name)
  if (names.some((tool: unknown) => tool !== "workflow_command")) return false
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
  const consumedApprovals = new Set<string>()
  const plans = new Map<string, WorkflowPlan>()
  const workspaceEvidence = new Map<string, WorkspaceResult[]>()
  const updateQueues = new Map<string, Promise<unknown>>()
  const signals = new Map<string, Set<() => void>>()
  const wake = (runId: string) => { for (const fn of signals.get(runId) ?? []) fn() }

  const get = async (runId: string) => { const record = await options.state.read(runId); if (!record) throw new Error("Run absent"); return record }
  const update = async (runId: string, fn: (record: RunRecord) => RunRecord) => {
    const prior = updateQueues.get(runId) ?? Promise.resolve()
    let result!: RunRecord
    const current = prior.then(async () => { const atomic = (options.state as any).update; if (typeof atomic === "function") result = await atomic.call(options.state, runId, fn); else { const record = await get(runId); result = fn(record); await options.state.write(runId, result) }; wake(runId) })
    updateQueues.set(runId, current.catch(() => {})); await current; return result
  }
  const failStep = async (runId: string, stepId: string, reason: string) => update(runId, (r) => ({ ...r, steps: r.steps.map((s) => s.id === stepId ? { ...s, state: "failed", failure: reason, finishedAt: iso(now) } : s), updatedAt: iso(now) }))
  const schedule = async (runId: string): Promise<void> => {
    let record = await get(runId), plan = plans.get(runId)
    if (!plan || terminal(record.state) || cancelled.has(runId)) return
    while (!terminal(record.state) && !cancelled.has(runId)) {
      const ready = topologicalReadySteps(plan, record.steps).filter((step) => !record.steps.some((s) => s.id === step.id && s.state !== "queued"))
      const capacity = plan.maxConcurrency - (active.get(runId)?.size ?? 0)
      for (const step of ready.slice(0, Math.max(0, capacity))) {
        const reservation = `pending:${step.id}:${randomUUID()}`
        ;(active.get(runId) ?? new Set()).add(reservation)
        await update(runId, (r) => ({ ...r, steps: r.steps.map((s) => s.id === step.id ? { ...s, state: "ready" } : s), updatedAt: iso(now) }))
        void execute(runId, plan, step, reservation).catch(async (e) => { await failStep(runId, step.id, errorText(e)); wake(runId) })
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
  async function execute(runId: string, plan: WorkflowPlan, step: WorkflowStep, reservation: string) {
    // Session creation is intentionally outside the scheduler's critical path.
    const workspace = options.workspace?.resolve ? await options.workspace.resolve(step) : undefined
    if (workspace) { const list = workspaceEvidence.get(runId) ?? []; list.push(workspace); workspaceEvidence.set(runId, list); await update(runId, (r) => ({ ...r, workspaces: list, updatedAt: iso(now) } as any)) }
    const session = await options.sessions.create({ directory: workspace?.path ?? options.repositoryRoot ?? ".", title: `${plan.definition.name}:${step.id}` })
    if (cancelled.has(runId)) { await options.sessions.abort(session.sessionID).catch(() => {}); return }
    const binding = { runId, stepId: step.id, sessionID: session.sessionID, policyHash: plan.policyHash, workspace }
    bindings.set(session.sessionID, binding); const set = active.get(runId) ?? new Set<string>(); set.delete(reservation); set.add(session.sessionID); active.set(runId, set)
    await update(runId, (r) => ({ ...r, steps: r.steps.map((s) => s.id === step.id ? { ...s, state: "running", sessionID: session.sessionID, startedAt: iso(now) } : s), updatedAt: iso(now) }))
    try {
      const current = await get(runId)
      if (cancelled.has(runId)) throw new Error("Workflow cancelled")
      const inputs = step.inputs.map((input) => ({ ...input, value: current.steps.find((s) => s.id === input.step)?.outputs?.[input.output] }))
      await options.sessions.promptAsync({ sessionID: session.sessionID, agent: RESERVED_AGENT, model: step.model.mode === "alias" ? step.model.alias : undefined, system: JSON.stringify({ step: step.id, policyHash: plan.policyHash, inputs, outputs: step.outputs, tools: ["workflow_command"], limits: step.limits }), tools: ["workflow_command"], parts: [{ type: "text", text: step.prompt }] })
      const deadline = now() + step.limits.timeoutSeconds * 1000
      let status: any
      try { status = await options.sessions.status(session.sessionID) } catch { throw new Error("Lost native session") }
      while (status.type === "running" && now() < deadline && !cancelled.has(runId)) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - now()))))
        try { status = await options.sessions.status(session.sessionID) } catch { throw new Error("Lost native session") }
      }
      if (cancelled.has(runId)) throw new Error("Workflow cancelled")
      if (status.type === "running") throw new Error(now() >= deadline ? "Session timed out" : "Session did not complete")
      if (status.type !== "completed") throw new Error(status.error ?? "Session failed")
      const outputs = outputFromMessages(await options.sessions.messages(session.sessionID), step)
      await update(runId, (r) => ({ ...r, steps: r.steps.map((s) => s.id === step.id ? { ...s, state: "succeeded", outputs, finishedAt: iso(now) } : s), updatedAt: iso(now) }))
      const after = await get(runId)
      if (after.steps.every((s) => s.state === "succeeded" || s.state === "skipped") && !terminal(after.state)) await update(runId, (r) => ({ ...r, state: "succeeded", updatedAt: iso(now) }))
    } catch (e) { if (!cancelled.has(runId)) await failStep(runId, step.id, errorText(e)) }
    finally { set.delete(session.sessionID); set.delete(reservation); bindings.delete(session.sessionID); wake(runId); await schedule(runId) }
  }
  const launch = async (plan: WorkflowPlan, approval: LaunchApproval) => {
    if (!options.registerToolHook) throw new Error("Host tool enforcement unavailable")
    if (!options.consumeApproval) throw new Error("Authoritative approval consumer unavailable")
    if (!agentMatches(options.agent) || options.agent?.name !== RESERVED_AGENT) throw new Error("Reserved workflow agent is unavailable or mismatched")
    if (approval.workflowHash !== plan.workflowHash || approval.policyHash !== plan.policyHash || !approval.singleUse || consumedApprovals.has(approval.token)) throw new Error("Launch approval does not match plan")
    const tokenHash = createHash("sha256").update(approval.token).digest("hex")
    if (options.consumeApproval && !(await options.consumeApproval(approval.token, plan.workflowHash, plan.policyHash))) throw new Error("Launch approval already consumed")
    const listed = typeof (options.state as any).listRuns === "function" ? await (options.state as any).listRuns() : []
    for (const prior of listed) if ((prior as any).approval?.tokenHash === tokenHash) throw new Error("Launch approval already consumed")
    consumedApprovals.add(approval.token)
    const runId = randomUUID(), timestamp = iso(now)
    const record: RunRecord = { runId, workflowName: plan.definition.name, revision: 1, workflowHash: plan.workflowHash, state: "running", createdAt: timestamp, updatedAt: timestamp, steps: plan.steps.map((s) => ({ id: s.id, state: "queued" })), policyHash: plan.policyHash }
    await options.state.write(runId, { ...record, repository: options.repositoryId && options.repositoryRoot ? { id: options.repositoryId, directory: options.repositoryRoot } : undefined, evidence: { ownership: "opencode-native-swarms", sessionHash: createHash("sha256").update(runId).digest("hex") }, approval: { tokenHash, consumed: true } } as any); plans.set(runId, plan); active.set(runId, new Set()); void schedule(runId).catch(async (e) => { await update(runId, (r) => ({ ...r, state: "failed", updatedAt: iso(now), failure: errorText(e) } as any)) }); return { runId }
  }
  const status = get
  const wait = async (runId: string, timeoutMs: number) => { const initial = await get(runId); if (terminal(initial.state)) return initial; let unsubscribe: (() => void) | undefined; const result = await new Promise<RunRecord>((resolve) => { let done = false; const finish = async () => { if (!done) { done = true; clearTimeout(timer); signals.get(runId)?.delete(finish); unsubscribe?.(); resolve(await get(runId)) } }; const timer = setTimeout(finish, Math.max(0, timeoutMs)); const list = signals.get(runId) ?? new Set(); list.add(finish); signals.set(runId, list); if (options.event?.subscribe) { const handler = (event: any) => { const sid = event?.sessionID ?? event?.session?.id; if (sid && [...bindings.values()].some((b) => b.runId === runId && b.sessionID === sid)) void finish() }; const value = options.event.subscribe(handler); if (typeof value === "function") unsubscribe = value; else void value.then((fn) => { unsubscribe = fn }) } }); return terminal(result.state) ? result : { ...result, timedOut: true } }
  const cancel = async (runId: string) => { cancelled.add(runId); for (const session of active.get(runId) ?? []) if (!session.startsWith("pending:")) await options.sessions.abort(session).catch(() => {}); return update(runId, (x) => x.state === "running" ? { ...x, state: "cancelled", steps: x.steps.map((s) => s.state === "queued" || s.state === "ready" || s.state === "running" ? { ...s, state: "cancelled", finishedAt: iso(now) } : s), updatedAt: iso(now) } : x) }
  const amend = async (runId: string, input: unknown) => { if (!options.amend) throw new Error("Amendment adapter unavailable"); const current = await get(runId), result = await options.amend(runId, input); const revision = current.revision + 1; plans.set(runId, result.plan); await update(runId, (r) => ({ ...r, revision, workflowHash: result.plan.workflowHash, policyHash: result.plan.policyHash, state: "awaiting-approval", updatedAt: iso(now) })); return { revision, approval: result.summary } }
  const resume = async (runId: string, approval: LaunchApproval) => { const current = await get(runId), plan = plans.get(runId); if (!plan || approval.workflowHash !== current.workflowHash || approval.policyHash !== current.policyHash) throw new Error("Resume approval does not match run"); if (options.revalidate) await options.revalidate(runId, plan); await options.state.resume(runId, { revision: current.revision, policyHash: current.policyHash }); await update(runId, (r) => ({ ...r, state: "running", updatedAt: iso(now) })); cancelled.delete(runId); void schedule(runId); return get(runId) }
  const cleanup = async (runId: string) => { const r = await get(runId), workspaces = ((r as any).workspaces ?? workspaceEvidence.get(runId)) as readonly WorkspaceResult[] | undefined; if (!workspaces?.length || !options.workspace) return { cleaned: false, reason: "Workspace evidence unavailable" } as CleanupResult; let result: CleanupResult = { cleaned: true }; for (const workspace of workspaces) { const next = await cleanupWorkspace({ ...workspace, failed: r.state === "failed", cancelled: r.state === "cancelled" }, options.workspace); if (!next.cleaned) return next; result = next } return result }
  const beforeTool = (id: string, tool: string) => { if (!bindings.has(id)) throw new Error("Unbound workflow session"); if (BUILTIN_TOOLS.has(tool)) throw new Error("Built-in tool denied for workflow session") }
  if (options.registerToolHook) options.registerToolHook(({ sessionID, tool }) => beforeTool(sessionID, tool))
  return { launch, status, wait, cancel, amend, resume, cleanup, binding: (id) => bindings.get(id), beforeTool }
}

export const createRuntime = createWorkflowRuntime
