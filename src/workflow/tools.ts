import { randomUUID, createHash } from "node:crypto"
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import { z } from "zod"
import { parseWorkflow } from "./schema"
import type { ApprovalSummary, LaunchApproval, PolicyDecision, WorkflowPlan } from "./types"
import type { WorkflowRuntime } from "./runtime"

type RuntimeLike = Pick<WorkflowRuntime, "launch" | "status" | "wait" | "cancel" | "amend" | "resume" | "cleanup"> & Partial<Pick<WorkflowRuntime, "binding">>
type ToolOptions = Readonly<{
  runtime: RuntimeLike
  plan?: (value: unknown, context: ToolContext) => Promise<WorkflowPlan>
  save?: (value: unknown, context: ToolContext) => Promise<unknown>
  command?: (input: any, context: ToolContext) => Promise<unknown>
  commandBinding?: (input: any, context: ToolContext) => Promise<unknown>
  approvalTimeoutMs?: number
  broker?: ApprovalBroker
}>

const json = (value: unknown) => ({ output: JSON.stringify(value), title: "Workflow" })
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const lifecycle = z.object({ runId: z.string().regex(/^[A-Za-z0-9_-]+$/) }).strict()
const workflowInput = z.object({ workflow: z.unknown() }).strict()
const commandSpec = z.object({ executable: z.string().min(1), argv: z.array(z.string()), cwd: z.string(), env: z.array(z.string()) }).strict()

export type ApprovalBroker = Readonly<{
  request(summary: ApprovalSummary, sessionID: string, context: ToolContext): Promise<Readonly<{ decision: PolicyDecision; token?: string }>>
  permissionAsk(input: any, output: { status: "ask" | "deny" | "allow" }): void
  event(input: any): void
  pending(): number
  consume(token: string, workflowHash?: string, policyHash?: string): boolean
}>

/** Correlates host permission callbacks without trusting their ordering. */
export function createApprovalBroker(options: Readonly<{ timeoutMs?: number }> = {}): ApprovalBroker {
  const pending = new Map<string, { resolve: (decision: PolicyDecision) => void; permissionID?: string }>()
  const consumed = new Set<string>()
  const issued = new Map<string, { workflowHash: string; policyHash: string; sessionID: string; expiresAt: number }>()
  const request = (summary: ApprovalSummary, sessionID: string, context: ToolContext) => new Promise<Readonly<{ decision: PolicyDecision; token?: string }>>(async (resolve) => {
    const requestID = randomUUID()
    const timer = setTimeout(() => { pending.delete(requestID); resolve({ decision: { allowed: false, layer: "approval", reason: "Approval reply timed out" } }) }, options.timeoutMs ?? 60_000)
    pending.set(requestID, { resolve: (decision) => { clearTimeout(timer); pending.delete(requestID); const token = decision.allowed ? `${requestID}.${hash({ requestID, summary, sessionID })}` : undefined; if (token) issued.set(token, { workflowHash: summary.workflowHash, policyHash: summary.policyHash, sessionID, expiresAt: Date.now() + 60_000 }); resolve({ decision, token }) } })
    const onAbort = () => { if (pending.has(requestID)) pending.get(requestID)!.resolve({ allowed: false, layer: "approval", reason: "Approval request aborted" }) }
    if (context.abort.aborted) onAbort(); else context.abort.addEventListener("abort", onAbort, { once: true })
    try {
      const redacted = { ...summary, commands: summary.commands.map((c) => ({ executable: c.executable, argv: c.argv, cwd: c.cwd })) }
      await context.ask({ permission: "workflow.launch", patterns: [summary.workflowHash], always: [summary.workflowHash], metadata: { requestID, workflowHash: summary.workflowHash, policyHash: summary.policyHash, sessionID, summary: redacted } })
    }
    catch { clearTimeout(timer); pending.delete(requestID); resolve({ decision: { allowed: false, layer: "approval", reason: "Approval request failed" } }) }
  })
  const permissionAsk = (input: any, output: { status: "ask" | "deny" | "allow" }) => {
    const metadata = input?.metadata ?? input?.request?.metadata ?? {}
    const requestID = metadata.requestID
    if (!requestID || !pending.has(requestID)) return
    if (input?.id || input?.permissionID) pending.get(requestID)!.permissionID = input.id ?? input.permissionID
    if (output.status === "deny") pending.get(requestID)!.resolve({ allowed: false, layer: "approval", reason: "Workflow launch denied" })
    else if (output.status === "allow") pending.get(requestID)!.resolve({ allowed: true, layer: "approval", reason: "Workflow launch approved" })
  }
  const event = (input: any) => {
    const event = input?.event ?? input
    if (event?.type !== "permission.replied") return
    const permissionID = event.permissionID ?? event.properties?.permissionID ?? event.properties?.id
    const status = event.status ?? event.properties?.status
    for (const item of pending.values()) if (item.permissionID === permissionID) item.resolve({ allowed: status === "allow", layer: "approval", reason: status === "allow" ? "Workflow launch approved" : "Workflow launch denied" })
  }
  const consume = (token: string, workflowHash?: string, policyHash?: string) => { const item = issued.get(token); if (!item || consumed.has(token) || item.expiresAt < Date.now() || workflowHash && item.workflowHash !== workflowHash || policyHash && item.policyHash !== policyHash) return false; consumed.add(token); return true }
  return { request, permissionAsk, event, pending: () => pending.size, consume }
}

export function createWorkflowTools(options: ToolOptions): Record<string, ToolDefinition> {
  const broker = options.broker ?? createApprovalBroker({ timeoutMs: options.approvalTimeoutMs })
  const validate = tool({ description: "Validate a workflow definition", args: { workflow: z.unknown() }, async execute(args) { return json(parseWorkflow(args.workflow)) } })
  const launch = tool({ description: "Approve and launch a workflow", args: { workflow: z.unknown() }, execute: async (args, context) => {
    const parsed = parseWorkflow(args.workflow)
    if (!parsed.value) return json(parsed)
    const plan = options.plan ? await options.plan(parsed.value, context) : ({ definition: parsed.value, steps: parsed.value.steps, policy: { hash: "" }, policyHash: "", workflowHash: parsed.value.hash, maxConcurrency: parsed.value.maxConcurrency } as unknown as WorkflowPlan)
    const summary: ApprovalSummary = { workflowHash: plan.workflowHash, policyHash: plan.policyHash, source: context.directory, revision: 1, capabilities: plan.policy.capabilities, modes: plan.definition.workspace.allowedModes, workspace: plan.definition.workspace, agents: plan.steps.map(() => "native-swarms-workflow-step"), models: plan.steps.map((s) => s.model.mode === "alias" ? (s.model.alias ?? "alias") : s.model.mode), dependencies: plan.steps.map((s) => ({ id: s.id, dependsOn: s.dependsOn })), concurrency: plan.maxConcurrency, ceiling: plan.policy, paths: { read: plan.policy.readPaths, write: plan.policy.writePaths }, writeOperations: plan.steps.filter((s) => s.permissions.writePaths.length).map((s) => s.id), limits: plan.steps.map((s) => ({ id: s.id, ...s.limits })), commands: [...plan.definition.commands.allow, ...plan.steps.flatMap((s) => s.commands)], reasons: ["Launch a validated workflow"] }
    const approval = await broker.request(summary, context.sessionID, context)
    if (!approval.decision.allowed || !approval.token) return json({ error: approval.decision.reason ?? "Workflow launch denied" })
    const result = await options.runtime.launch(plan, { token: approval.token, workflowHash: plan.workflowHash, policyHash: plan.policyHash, singleUse: true, summary })
    return json({ ...result, approval: summary })
  } })
  const delegated = (name: string, fn: (args: any) => Promise<unknown>) => tool({ description: `Workflow ${name}`, args: { runId: z.string().regex(/^[A-Za-z0-9_-]+$/), ...(name === "wait" ? { timeoutMs: z.number().int().nonnegative().default(1000) } : {}) }, execute: async (args) => json(await fn(args)) })
  const command = tool({ description: "Run an exact approved workflow command", args: { sessionID: z.string(), runID: z.string(), stepID: z.string(), command: commandSpec, approvalToken: z.string().optional() }, execute: async (args, context) => {
    const checked = commandSpec.safeParse(args.command)
    if (!checked.success) throw new Error("workflow_command requires a structured command")
    const binding = options.runtime.binding?.(context.sessionID)
    if (!binding || binding.runId !== args.runID || binding.stepId !== args.stepID || args.sessionID !== context.sessionID) throw new Error("workflow_command scope mismatch")
    const approved = (binding as any).approvedCommand
    if (approved && JSON.stringify(approved) !== JSON.stringify(checked.data)) throw new Error("workflow_command command mismatch")
    const expectedToken = (binding as any).approvalToken
    if (expectedToken && args.approvalToken !== expectedToken) throw new Error("workflow_command token mismatch")
    if (options.commandBinding) return json(await options.commandBinding({ ...args, command: checked.data, policyHash: binding.policyHash }, context))
    if (!options.command) throw new Error("workflow_command executor unavailable")
    return json(await options.command({ ...args, command: checked.data }, context))
  } })
  return {
    workflow_validate: validate,
    workflow_launch: launch,
    workflow_command: command,
    workflow_save: tool({ description: "Save a workflow", args: { workflow: z.unknown() }, async execute(args, context) { if (!options.save) throw new Error("Workflow save unavailable"); return json(await options.save(args.workflow, context)) } }),
    workflow_inspect: delegated("inspect", (a) => options.runtime.status(a.runId)),
    workflow_status: delegated("status", (a) => options.runtime.status(a.runId)),
    workflow_wait: delegated("wait", (a) => options.runtime.wait(a.runId, a.timeoutMs)),
    workflow_cancel: delegated("cancel", (a) => options.runtime.cancel(a.runId)),
    workflow_amend: tool({ description: "Amend a workflow", args: { runId: z.string().regex(/^[A-Za-z0-9_-]+$/), workflow: z.unknown() }, execute: async (a) => json(await options.runtime.amend(a.runId, a.workflow)) }),
    workflow_resume: tool({ description: "Resume a workflow", args: { runId: z.string().regex(/^[A-Za-z0-9_-]+$/), approval: z.object({ token: z.string(), workflowHash: z.string(), policyHash: z.string(), singleUse: z.literal(true), summary: z.any() }) }, execute: async (a) => json(await options.runtime.resume(a.runId, a.approval as LaunchApproval)) }),
    workflow_cleanup: delegated("cleanup", (a) => options.runtime.cleanup(a.runId)),
  }
}

export { lifecycle }
