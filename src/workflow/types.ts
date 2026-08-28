export const CAPABILITIES = [
  "repo.read", "repo.search", "git.status", "git.diff", "git.log", "git.stage", "git.commit",
  "web.search", "web.fetch", "test.run", "typecheck.run", "lint.run", "build.run",
  "workspace.patch", "workspace.create", "workspace.delete", "agents.spawn", "agents.message", "agents.wait",
] as const
export type Capability = (typeof CAPABILITIES)[number]

export const WORKSPACE_MODES = ["read-only", "current", "worktree", "existing"] as const
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number]
export type FailurePolicy = "fail-fast" | "continue-independent"
export const OUTPUT_TYPES = ["json", "markdown", "text", "number", "boolean"] as const
export type OutputType = (typeof OUTPUT_TYPES)[number]
export const WORKFLOW_STATES = ["draft", "awaiting-approval", "running", "succeeded", "failed", "cancelled", "stale"] as const
export type WorkflowState = (typeof WORKFLOW_STATES)[number]
export const STEP_STATES = ["queued", "ready", "running", "succeeded", "failed", "cancelled", "skipped"] as const
export type StepState = (typeof STEP_STATES)[number]

/** Repository-root-relative POSIX glob, normalized by the schema layer. */
export type PathScope = string
export type CommandSpec = Readonly<{
  executable: string
  argv: readonly string[]
  cwd: string
  env: readonly string[]
}>
export type PermissionPolicy = Readonly<{
  capabilities: readonly Capability[]
  deny: readonly Capability[]
  readPaths: readonly PathScope[]
  writePaths: readonly PathScope[]
}>
export type EffectivePolicy = Readonly<PermissionPolicy & { hash: string }>
export type InstallationPolicy = Readonly<{
  permissions: PermissionPolicy
  maxConcurrency: number
  maxTimeoutSeconds: number
  maxOutputBytes: number
  protectedPaths: readonly PathScope[]
  commands?: Readonly<{ default: "deny"; allow: readonly CommandSpec[]; deny: readonly CommandSpec[] }>
}>

export type ModelSpec = Readonly<{ mode: "configured" | "inherit" | "alias"; alias?: string }>
export type OutputDeclaration = Readonly<{ name: string; type: OutputType; required: boolean }>
export type InputReference = Readonly<{ step: string; output: string; as: string }>
export type StepLimits = Readonly<{ timeoutSeconds: number; maxOutputBytes: number; maxChildAgents: number }>
export type WorkflowStep = Readonly<{
  id: string
  description?: string
  prompt: string
  dependsOn: readonly string[]
  model: ModelSpec
  workspace: Readonly<{ mode: WorkspaceMode }>
  permissions: PermissionPolicy
  commands: readonly CommandSpec[]
  inputs: readonly InputReference[]
  outputs: readonly OutputDeclaration[]
  limits: StepLimits
}>
export type WorkflowDefinition = Readonly<{
  schemaVersion: 1
  name: string
  description?: string
  failurePolicy: FailurePolicy
  maxConcurrency: number
  permissions: PermissionPolicy
  workspace: Readonly<{ allowedModes: readonly WorkspaceMode[]; defaultMode: WorkspaceMode }>
  commands: Readonly<{ default: "deny"; allow: readonly CommandSpec[]; deny: readonly CommandSpec[] }>
  steps: readonly WorkflowStep[]
  hash?: string
}>

export type OutputValue = Readonly<{ type: OutputType; value: unknown }>
export type CommandEvidence = Readonly<{
  command: CommandSpec
  allowed: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
  timedOut?: boolean
  outputLimited?: boolean
  policyHash?: string
}>
export type StepRecord = Readonly<{
  id: string
  state: StepState
  sessionID?: string
  startedAt?: string
  finishedAt?: string
  failure?: string
  outputs?: Readonly<Record<string, OutputValue>>
  evidence?: readonly CommandEvidence[]
}>
export type RunRecord = Readonly<{
  runId: string
  workflowName: string
  revision: number
  workflowHash: string
  state: WorkflowState
  createdAt: string
  updatedAt: string
  steps: readonly StepRecord[]
  policyHash: string
  repository?: Readonly<{ id: string; directory: string }>
}>
export type WorkflowPlan = Readonly<{
  definition: WorkflowDefinition
  steps: readonly WorkflowStep[]
  policy: EffectivePolicy
  policyHash: string
  workflowHash: string
  maxConcurrency: number
}>

export type SessionStatus = Readonly<{ type: "running" | "completed" | "failed" | "aborted"; error?: string }>
export type SessionMessage = Readonly<{ role: "user" | "assistant" | "system"; parts: readonly unknown[] }>
export interface SessionAdapter {
  create(input: { readonly directory: string; readonly parentID?: string; readonly title: string }): Promise<{ readonly sessionID: string }>
  promptAsync(input: { readonly sessionID: string; readonly agent: string; readonly model?: string; readonly system: string; readonly tools: readonly string[]; readonly parts: readonly unknown[] }): Promise<void>
  status(sessionID: string): Promise<SessionStatus>
  abort(sessionID: string): Promise<void>
  messages(sessionID: string): Promise<readonly SessionMessage[]>
}
export interface ProcessAdapter {
  run(input: { readonly argv: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly maxStdoutBytes: number; readonly maxStderrBytes: number; readonly signal?: AbortSignal }): Promise<Readonly<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean; outputLimited?: boolean }>>
}
export interface FilesystemAdapter {
  realpath(path: string): Promise<string>
  atomicWrite(path: string, data: string): Promise<void>
  read(path: string): Promise<string>
  isSymlink(path: string): Promise<boolean>
  acquireLock(path: string): Promise<Readonly<{ release(): Promise<void> }>>
}
export interface EnvironmentProvider {
  get(name: string): string | undefined
  homeDirectory(): string
}
export interface ApprovalManager {
  request(summary: ApprovalSummary, sessionID: string): Promise<Readonly<{ decision: PolicyDecision; token?: string }>>
}
export type GitAdapter = Readonly<Record<string, (...args: never[]) => Promise<unknown>>>
export type RepositoryStateAdapter = Readonly<Record<string, (...args: never[]) => Promise<unknown>>>
export type WorkflowAdapters = Readonly<{
  now: () => number
  sessions: SessionAdapter
  processes: ProcessAdapter
  git: GitAdapter
  filesystem: FilesystemAdapter
  environment: EnvironmentProvider
  approval: ApprovalManager
  state: RepositoryStateAdapter
}>

export type PolicyDecision = Readonly<{ allowed: boolean; layer?: string; rule?: string; reason?: string }>
export type LaunchApproval = Readonly<{ token: string; workflowHash: string; policyHash: string; singleUse: true; summary: ApprovalSummary }>
export type ApprovalSummary = Readonly<{ workflowHash: string; policyHash: string; capabilities: readonly Capability[]; modes: readonly WorkspaceMode[]; commands: readonly CommandSpec[]; reasons: readonly string[] }>
export type CleanupResult = Readonly<{ cleaned: boolean; reason?: string; workspace?: string }>
