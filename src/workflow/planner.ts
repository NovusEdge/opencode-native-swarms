import { createHash } from "node:crypto"
import picomatch from "picomatch"
import { decideCapability, decidePath } from "./policy"
import { checkWriterOverlap, type WriterHandoff } from "./workspace"
import type { EffectivePolicy, FailurePolicy, StepState, WorkflowDefinition, WorkflowPlan, WorkflowState, WorkflowStep } from "./types"

export type PlannerInput = Readonly<{
  definition: WorkflowDefinition
  policy: EffectivePolicy
  installation?: Readonly<{ maxConcurrency?: number; maxTimeoutSeconds?: number; maxOutputBytes?: number; protectedPaths?: readonly string[] }>
  workspacePlans?: Readonly<Record<string, Readonly<{ path: string; repositoryId?: string; mode?: string }>>>
  writerScopes?: Readonly<Record<string, readonly string[]>>
  handoffs?: Readonly<Record<string, WriterHandoff>>
  repositoryId?: string
}>

const immutable = <T>(value: T): T => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) immutable(child)
  return Object.freeze(value)
}
const sorted = (values: readonly string[]) => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
const pathValid = (p: string) => !!p && !p.includes("\\") && !p.includes("\0") && !p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p) && !p.split("/").includes("..")
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v, Object.keys(v as object).sort())).digest("hex")

function output(step: WorkflowStep, name: string) { return step.outputs.find((item) => item.name === name) }
function ensureScope(pattern: string, label: string) {
  if (!pathValid(pattern)) throw new Error(`Invalid ${label} scope`)
  try { picomatch(pattern) } catch { throw new Error(`Invalid ${label} scope`) }
}

export function planWorkflow(input: PlannerInput): WorkflowPlan {
  const { definition, policy } = input
  const byId = new Map<string, WorkflowStep>()
  for (const step of definition.steps) {
    if (byId.has(step.id)) throw new Error(`Duplicate step id: ${step.id}`)
    byId.set(step.id, step)
    if (!definition.workspace.allowedModes.includes(step.workspace.mode)) throw new Error(`Workspace mode is not allowed: ${step.id}`)
    for (const p of [...step.permissions.readPaths, ...step.permissions.writePaths]) ensureScope(p, `step ${step.id}`)
    for (const p of [...definition.permissions.readPaths, ...definition.permissions.writePaths]) ensureScope(p, "workflow")
    for (const command of step.commands) {
      const layers = (policy as EffectivePolicy & { layers?: readonly Readonly<{ capabilities: readonly string[] }>[] }).layers
      const decision = layers ? layers.every((layer) => layer.capabilities.includes("repo.read")) : true
      if (!decision) throw new Error(`Command unavailable under compiled policy: ${step.id}`)
    }
    if (input.installation?.maxTimeoutSeconds !== undefined && step.limits.timeoutSeconds > input.installation.maxTimeoutSeconds) throw new Error(`Timeout exceeds installation limit: ${step.id}`)
    if (input.installation?.maxOutputBytes !== undefined && step.limits.maxOutputBytes > input.installation.maxOutputBytes) throw new Error(`Output limit exceeds installation limit: ${step.id}`)
    for (const capability of step.permissions.capabilities) if (!decideCapability(policy, capability).allowed) throw new Error(`Capability unavailable: ${capability}`)
    for (const p of step.permissions.readPaths) if (!decidePath(policy, "read", p).allowed) throw new Error(`Read scope outside policy: ${p}`)
    for (const p of step.permissions.writePaths) if (!decidePath(policy, "write", p).allowed) throw new Error(`Write scope outside policy: ${p}`)
    if (input.workspacePlans?.[step.id]?.repositoryId && input.repositoryId && input.workspacePlans[step.id].repositoryId !== input.repositoryId) throw new Error(`Workspace repository identity mismatch: ${step.id}`)
  }
  const indegree = new Map<string, number>(), children = new Map<string, string[]>()
  for (const step of definition.steps) {
    const deps = new Set(step.dependsOn)
    indegree.set(step.id, deps.size)
    for (const dep of deps) {
      const parent = byId.get(dep)
      if (!parent) throw new Error(`Missing dependency: ${dep}`)
      const list = children.get(dep) ?? []; list.push(step.id); children.set(dep, list)
    }
    for (const inputRef of step.inputs) {
      const parent = byId.get(inputRef.step)
      if (!parent) throw new Error(`Missing input step: ${inputRef.step}`)
      if (!deps.has(inputRef.step)) throw new Error(`Input step is not a dependency: ${step.id}`)
      if (!output(parent, inputRef.output)) throw new Error(`Missing output: ${inputRef.step}.${inputRef.output}`)
      const declared = output(parent, inputRef.output)!
      const expected = output(step, inputRef.as)
      if (expected && expected.type !== declared.type) throw new Error(`Input/output type mismatch: ${step.id}.${inputRef.as}`)
    }
  }
  const ready = sorted([...indegree].filter(([, count]) => count === 0).map(([id]) => id)), order: string[] = []
  while (ready.length) {
    const id = ready.shift()!; order.push(id)
    for (const child of sorted(children.get(id) ?? [])) { const count = indegree.get(child)! - 1; indegree.set(child, count); if (count === 0) { ready.push(child); ready.sort() } }
  }
  if (order.length !== definition.steps.length) throw new Error("Workflow dependency cycle")
  const writers = definition.steps.filter((s) => (input.writerScopes?.[s.id] ?? s.permissions.writePaths).length > 0)
  for (let i = 0; i < writers.length; i++) {
    const prior = writers.slice(0, i).map((s) => ({ step: s.id, scopes: input.writerScopes?.[s.id] ?? s.permissions.writePaths, dependsOn: s.dependsOn, handoff: input.handoffs?.[s.id] }))
    const candidate = { step: writers[i].id, scopes: input.writerScopes?.[writers[i].id] ?? writers[i].permissions.writePaths, dependsOn: writers[i].dependsOn, handoff: input.handoffs?.[writers[i].id] }
    const result = checkWriterOverlap(prior, candidate)
    if (!result.allowed) throw new Error(result.reason ?? "Writer overlap")
  }
  if (definition.maxConcurrency < 1 || (input.installation?.maxConcurrency !== undefined && definition.maxConcurrency > input.installation.maxConcurrency)) throw new Error("Concurrency exceeds installation limit")
  const steps = order.map((id) => byId.get(id)!)
  return immutable({ definition, steps, policy, policyHash: policy.hash, workflowHash: definition.hash || hash(definition), maxConcurrency: definition.maxConcurrency })
}

export function topologicalReadySteps(plan: WorkflowPlan, records: readonly Readonly<{ id: string; state: StepState }>[]): readonly WorkflowStep[] {
  const states = new Map(records.map((r) => [r.id, r.state]))
  return plan.steps.filter((step) => (states.get(step.id) ?? "queued") === "queued" && step.dependsOn.every((dep) => states.get(dep) === "succeeded"))
}

const workflowTransitions: Record<WorkflowState, readonly WorkflowState[]> = { draft: ["awaiting-approval"], "awaiting-approval": ["running"], running: ["succeeded", "failed", "cancelled", "stale"], succeeded: [], failed: [], cancelled: [], stale: [] }
const stepTransitions: Record<StepState, readonly StepState[]> = { queued: ["ready", "skipped"], ready: ["running", "cancelled"], running: ["succeeded", "failed", "cancelled"], succeeded: [], failed: [], cancelled: [], skipped: [] }
export function transitionWorkflow(record: Readonly<{ state: WorkflowState }> | WorkflowState, next: WorkflowState): WorkflowState {
  const current = typeof record === "string" ? record : record.state
  if (!workflowTransitions[current].includes(next)) throw new Error(`Illegal workflow transition: ${current} -> ${next}`)
  return next
}
export function transitionStep(record: Readonly<{ state: StepState }> | StepState, next: StepState): StepState {
  const current = typeof record === "string" ? record : record.state
  if (!stepTransitions[current].includes(next)) throw new Error(`Illegal step transition: ${current} -> ${next}`)
  return next
}

export type { FailurePolicy }
