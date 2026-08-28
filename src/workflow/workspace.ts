import picomatch from "picomatch"
import type { Capability, CleanupResult, FilesystemAdapter, WorkspaceMode } from "./types"

export type WorkspaceRequest = Readonly<{
  mode: WorkspaceMode
  repositoryRoot: string
  repositoryId: string
  path?: string
  branch?: string
  expectedRevision?: string
  write?: boolean
  workflowSelectsCurrent?: boolean
  installationAllowsWrites?: boolean
  launchApprovesWrites?: boolean
  capabilities?: readonly Capability[]
  requireClean?: boolean
  protectedPaths?: readonly string[]
  allowedModes?: readonly WorkspaceMode[]
  registered?: boolean
}>

export type WorkspaceResult = Readonly<{
  mode: WorkspaceMode
  path: string
  repositoryRoot: string
  repositoryId: string
  branch?: string
  revision?: string
  dirtySnapshot?: unknown
  managed: boolean
}>

export type WorkspaceFilesystem = Pick<FilesystemAdapter, "realpath" | "isSymlink">
export type WorkspaceGit = Readonly<Record<string, ((...args: any[]) => Promise<any>) | undefined>>
export type WorkspaceAdapters = Readonly<{ filesystem: WorkspaceFilesystem; git: WorkspaceGit }>

const badPath = (value: string) => !value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.split("/").includes("..")
const relative = (value: string) => value === "." ? "." : value.replace(/^\.\//, "")
const contained = (root: string, target: string) => target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`)
const scopesOverlap = (a: string, b: string) => picomatch(a, { dot: true, nocase: false })(b) || picomatch(b, { dot: true, nocase: false })(a)

async function identity(git: WorkspaceGit, path: string): Promise<string | undefined> {
  return typeof git.repositoryIdentity === "function" ? await git.repositoryIdentity(path) : undefined
}
async function status(git: WorkspaceGit, path: string): Promise<any> {
  return typeof git.status === "function" ? await git.status(path) : { clean: true }
}

export async function validateWorkspace(request: WorkspaceRequest, adapters: WorkspaceAdapters): Promise<WorkspaceResult> {
  if (!request.repositoryRoot || !request.repositoryRoot.startsWith("/")) throw new Error("Invalid repository root")
  if (request.allowedModes && !request.allowedModes.includes(request.mode)) throw new Error("Workspace mode is not allowed")
  if (request.path !== undefined && badPath(request.path)) throw new Error("Invalid workspace path")
  if (request.mode === "existing" && !request.registered) throw new Error("Existing workspace is not registered")
  if (request.mode === "current" && request.write && !(request.workflowSelectsCurrent && request.installationAllowsWrites && request.launchApprovesWrites && request.capabilities?.some((c) => c === "workspace.patch" || c === "workspace.create" || c === "workspace.delete"))) throw new Error("Current workspace write approval required")
  const root = await adapters.filesystem.realpath(request.repositoryRoot)
  const candidate = request.path ? (request.path.startsWith("/") ? request.path : `${root}/${relative(request.path)}`) : root
  const resolved = await adapters.filesystem.realpath(candidate)
  if (!contained(root, resolved)) throw new Error("Workspace containment check failed")
  if (await adapters.filesystem.isSymlink(candidate) && !contained(root, resolved)) throw new Error("Workspace symlink containment check failed")
  const actualIdentity = await identity(adapters.git, resolved)
  if (actualIdentity !== undefined && actualIdentity !== request.repositoryId) throw new Error("Workspace repository identity mismatch")
  if (request.mode === "existing" && request.expectedRevision) {
    const current = await status(adapters.git, resolved)
    if (current.revision !== request.expectedRevision && current.commit !== request.expectedRevision) throw new Error("Workspace revision mismatch")
  }
  const currentStatus = await status(adapters.git, resolved)
  if (request.mode === "current" && request.write && request.requireClean && currentStatus.clean !== true) throw new Error("Workspace clean precondition failed")
  return { mode: request.mode, path: resolved, repositoryRoot: root, repositoryId: request.repositoryId, branch: request.branch, revision: currentStatus.revision ?? currentStatus.commit, dirtySnapshot: request.mode === "current" && currentStatus.clean === false ? (currentStatus.snapshot ?? currentStatus) : undefined, managed: request.mode === "worktree" }
}

export async function resolveWorkspace(request: WorkspaceRequest, adapters: WorkspaceAdapters): Promise<WorkspaceResult> {
  if (request.mode === "worktree") {
    if (request.branch && (request.branch === "main" || request.branch === "master" || request.branch.startsWith("protected/"))) throw new Error("Protected branch")
    if (typeof adapters.git.createWorktree !== "function") throw new Error("Worktree adapter unavailable")
    const created = await adapters.git.createWorktree(request.repositoryRoot, request.branch)
    const path = typeof created === "string" ? created : created?.path
    if (!path) throw new Error("Worktree creation did not return a path")
    return validateWorkspace({ ...request, path, registered: true }, adapters)
  }
  return validateWorkspace(request, adapters)
}

export function checkWriterOverlap(existing: readonly Readonly<{ step: string; scopes: readonly string[]; dependsOn?: readonly string[]; handoff?: boolean }>[], candidate: Readonly<{ step: string; scopes: readonly string[]; dependsOn?: readonly string[]; handoff?: boolean }>): Readonly<{ allowed: boolean; reason?: string; conflictingStep?: string }> {
  for (const prior of existing) for (const a of prior.scopes) for (const b of candidate.scopes) if (scopesOverlap(a, b)) {
    const sequential = candidate.handoff === true && candidate.dependsOn?.includes(prior.step)
    if (!sequential) return { allowed: false, reason: "Overlapping parallel writer scopes", conflictingStep: prior.step }
  }
  return { allowed: true }
}

export function validateStagedPaths(paths: readonly string[], writeScopes: readonly string[], protectedPaths: readonly string[] = []): Readonly<{ allowed: boolean; path?: string; reason?: string }> {
  for (const path of paths) {
    if (badPath(path)) return { allowed: false, path, reason: "Malformed staged path" }
    if (protectedPaths.some((scope) => picomatch(scope, { dot: true, nocase: false })(path))) return { allowed: false, path, reason: "Protected staged path" }
    if (!writeScopes.some((scope) => picomatch(scope, { dot: true, nocase: false })(path))) return { allowed: false, path, reason: "Staged path outside write scopes" }
  }
  return { allowed: true }
}

export async function cleanupWorkspace(workspace: Readonly<Partial<WorkspaceResult> & { path: string; managed: boolean; failed?: boolean; cancelled?: boolean; status?: any; unpushedCommits?: boolean }>, adapters: WorkspaceAdapters): Promise<CleanupResult> {
  if (!workspace.managed) return { cleaned: false, reason: "Workspace is not plugin-managed", workspace: workspace.path }
  if (workspace.failed || workspace.cancelled) return { cleaned: false, reason: "Failed or cancelled workspace is preserved", workspace: workspace.path }
  const state = workspace.status ?? await status(adapters.git, workspace.path)
  if (state.clean !== true || state.unpushedCommits === true || workspace.unpushedCommits === true) return { cleaned: false, reason: "Cleanup could discard unrecorded changes or unpushed commits", workspace: workspace.path }
  const actualIdentity = await identity(adapters.git, workspace.path)
  if (actualIdentity !== undefined && workspace.repositoryId !== undefined && actualIdentity !== workspace.repositoryId) return { cleaned: false, reason: "Workspace repository identity mismatch", workspace: workspace.path }
  if (typeof adapters.git.removeWorktree !== "function" && typeof adapters.git.deleteWorktree !== "function") return { cleaned: false, reason: "Cleanup adapter unavailable", workspace: workspace.path }
  await (adapters.git.removeWorktree ?? adapters.git.deleteWorktree)!(workspace.path)
  return { cleaned: true, workspace: workspace.path }
}
