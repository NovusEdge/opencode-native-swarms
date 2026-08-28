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
  registration?: Readonly<{ owner: string; path: string; repositoryId: string }>
  approvalOperation?: "workspace.patch"
  writeScopes?: readonly string[]
  protectedBranches?: readonly string[]
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

const badPath = (value: string) => !value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.includes("//") || value.split("/").some((segment) => segment === ".." || segment === ".")
const badRoot = (value: string) => !value.startsWith("/") || value.includes("\0") || value.includes("\\") || value.includes("//") || value.split("/").some((segment) => segment === "." || segment === "..")
const relative = (value: string) => value === "." ? "." : value.replace(/^\.\//, "")
const contained = (root: string, target: string) => target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`)
const scopesOverlap = (a: string, b: string) => picomatch(a, { dot: true, nocase: false })(b) || picomatch(b, { dot: true, nocase: false })(a)

async function identity(git: WorkspaceGit, path: string): Promise<string | undefined> {
  if (typeof git.repositoryIdentity !== "function") throw new Error("Repository identity adapter unavailable")
  const value = await git.repositoryIdentity(path)
  if (typeof value !== "string" || !value) throw new Error("Repository identity evidence unavailable")
  return value
}
async function status(git: WorkspaceGit, path: string): Promise<any> {
  if (typeof git.status !== "function") throw new Error("Git status adapter unavailable")
  const value = await git.status(path)
  if (!value || typeof value !== "object") throw new Error("Git status evidence unavailable")
  return value
}

async function validateWorkspaceInternal(request: WorkspaceRequest, adapters: WorkspaceAdapters, trustedCreatedPath = false): Promise<WorkspaceResult> {
  if (!request.repositoryRoot || badRoot(request.repositoryRoot)) throw new Error("Invalid repository root")
  if (request.allowedModes && !request.allowedModes.includes(request.mode)) throw new Error("Workspace mode is not allowed")
  if (request.path !== undefined && (trustedCreatedPath ? !request.path.startsWith("/") : badPath(request.path))) throw new Error("Invalid workspace path")
  if (request.mode === "existing" && !request.registration) throw new Error("Existing workspace is not registered")
  if (request.branch && (request.protectedBranches ?? []).some((pattern) => { try { return !badPath(pattern) && picomatch(pattern, { dot: true, nocase: false })(request.branch!) } catch { return true } })) throw new Error("Protected branch")
  if (request.mode === "current" && request.write && !(request.workflowSelectsCurrent && request.installationAllowsWrites && request.launchApprovesWrites && request.approvalOperation === "workspace.patch" && request.capabilities?.includes("workspace.patch"))) throw new Error("Current workspace write approval required")
  for (const scope of request.protectedPaths ?? []) if (badPath(scope)) throw new Error("Invalid protected path scope")
  for (const scope of request.writeScopes ?? []) if (badPath(scope)) throw new Error("Invalid write path scope")
  const root = await adapters.filesystem.realpath(request.repositoryRoot)
  const candidate = request.path ? (request.path.startsWith("/") ? request.path : `${root}/${relative(request.path)}`) : root
  const resolved = await adapters.filesystem.realpath(candidate)
  if (!contained(root, resolved)) throw new Error("Workspace containment check failed")
  if (await adapters.filesystem.isSymlink(candidate) && !contained(root, resolved)) throw new Error("Workspace symlink containment check failed")
  const actualIdentity = await identity(adapters.git, resolved)
  if (actualIdentity !== undefined && actualIdentity !== request.repositoryId) throw new Error("Workspace repository identity mismatch")
  if (request.mode === "existing") {
    const registration = request.registration!
    if (registration.repositoryId !== request.repositoryId || registration.owner !== "opencode-native-swarms" || registration.path !== resolved) throw new Error("Workspace registration mismatch")
    if (typeof adapters.git.ownership !== "function" || await adapters.git.ownership(resolved) !== "opencode-native-swarms") throw new Error("Workspace ownership evidence unavailable")
  }
  if (request.mode === "existing" && request.expectedRevision) {
    const current = await status(adapters.git, resolved)
    if (current.revision !== request.expectedRevision && current.commit !== request.expectedRevision) throw new Error("Workspace revision mismatch")
  }
  const currentStatus = await status(adapters.git, resolved)
  if (request.mode === "current" && request.write && request.requireClean && currentStatus.clean !== true) throw new Error("Workspace clean precondition failed")
  if (request.write && request.protectedPaths?.some((scope) => picomatch(scope, { dot: true, nocase: false })(request.path ?? "."))) throw new Error("Workspace path is protected")
  return { mode: request.mode, path: resolved, repositoryRoot: root, repositoryId: request.repositoryId, branch: request.branch, revision: currentStatus.revision ?? currentStatus.commit, dirtySnapshot: request.mode === "current" && currentStatus.clean === false ? (currentStatus.snapshot ?? currentStatus) : undefined, managed: request.mode === "worktree" }
}
export async function validateWorkspace(request: WorkspaceRequest, adapters: WorkspaceAdapters): Promise<WorkspaceResult> {
  return validateWorkspaceInternal(request, adapters)
}

export async function resolveWorkspace(request: WorkspaceRequest, adapters: WorkspaceAdapters): Promise<WorkspaceResult> {
  if (request.mode === "worktree") {
    if (request.branch && (request.branch === "main" || request.branch === "master" || request.branch.startsWith("protected/"))) throw new Error("Protected branch")
    if (typeof adapters.git.createWorktree !== "function") throw new Error("Worktree adapter unavailable")
    const created = await adapters.git.createWorktree(request.repositoryRoot, request.branch)
    const path = typeof created === "string" ? created : created?.path
    if (!path) throw new Error("Worktree creation did not return a path")
    return validateWorkspaceInternal({ ...request, path, registration: { owner: "opencode-native-swarms", path, repositoryId: request.repositoryId } }, adapters, true)
  }
  return validateWorkspace(request, adapters)
}

export type WriterHandoff = Readonly<{ expectedTree?: string; expectedCommit?: string; workspaceIdentity: string }>
export function checkWriterOverlap(existing: readonly Readonly<{ step: string; scopes: readonly string[]; dependsOn?: readonly string[]; handoff?: WriterHandoff }>[], candidate: Readonly<{ step: string; scopes: readonly string[]; dependsOn?: readonly string[]; handoff?: WriterHandoff }>): Readonly<{ allowed: boolean; reason?: string; conflictingStep?: string }> {
  const validScope = (scope: string) => { if (badPath(scope)) return false; try { picomatch(scope, { dot: true, nocase: false }); return true } catch { return false } }
  if (candidate.scopes.some((scope) => !validScope(scope)) || existing.some((w) => w.scopes.some((scope) => !validScope(scope)))) return { allowed: false, reason: "Malformed writer scope" }
  for (const prior of existing) for (const a of prior.scopes) for (const b of candidate.scopes) if (scopesOverlap(a, b)) {
    const sequential = !!candidate.handoff && candidate.dependsOn?.includes(prior.step) && !!candidate.handoff.workspaceIdentity && (!!candidate.handoff.expectedTree || !!candidate.handoff.expectedCommit)
    if (!sequential) return { allowed: false, reason: "Overlapping parallel writer scopes", conflictingStep: prior.step }
  }
  return { allowed: true }
}

export function validateStagedPaths(paths: readonly string[], writeScopes: readonly string[], protectedPaths: readonly string[] = []): Readonly<{ allowed: boolean; path?: string; reason?: string }> {
  try { for (const scope of [...writeScopes, ...protectedPaths]) { if (badPath(scope)) return { allowed: false, reason: "Malformed scope" }; picomatch(scope, { dot: true, nocase: false }) } } catch { return { allowed: false, reason: "Malformed scope" } }
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
  if (!workspace.repositoryRoot || !workspace.repositoryId) return { cleaned: false, reason: "Workspace identity or root evidence unavailable", workspace: workspace.path }
  const root = await adapters.filesystem.realpath(workspace.repositoryRoot)
  const resolved = await adapters.filesystem.realpath(workspace.path)
  if (root && !contained(root, resolved)) return { cleaned: false, reason: "Workspace containment check failed", workspace: workspace.path }
  const state = await status(adapters.git, resolved)
  if (state.clean !== true || state.unpushedCommits === true || workspace.unpushedCommits === true) return { cleaned: false, reason: "Cleanup could discard unrecorded changes or unpushed commits", workspace: workspace.path }
  const actualIdentity = await identity(adapters.git, resolved)
  if (actualIdentity !== workspace.repositoryId) return { cleaned: false, reason: "Workspace repository identity mismatch", workspace: workspace.path }
  if (typeof adapters.git.ownership !== "function") return { cleaned: false, reason: "Workspace ownership adapter unavailable", workspace: workspace.path }
  const owner = await adapters.git.ownership(resolved)
  if (owner !== "opencode-native-swarms") return { cleaned: false, reason: "Workspace ownership mismatch", workspace: workspace.path }
  if (typeof adapters.git.removeWorktree !== "function" && typeof adapters.git.deleteWorktree !== "function") return { cleaned: false, reason: "Cleanup adapter unavailable", workspace: workspace.path }
  const removalBoundary = adapters.git.removalBoundary
  if (typeof removalBoundary !== "function") return { cleaned: false, reason: "Removal boundary adapter unavailable", workspace: workspace.path }
  await removalBoundary(resolved, root, workspace.repositoryId)
  await (adapters.git.removeWorktree ?? adapters.git.deleteWorktree)!(resolved)
  return { cleaned: true, workspace: workspace.path }
}

/** Final check performed immediately before a filesystem write or Git mutation. */
export async function assertWriteBoundary(path: string, repositoryRoot: string, adapters: WorkspaceAdapters, protectedPaths: readonly string[] = [], operationPaths: readonly string[] = [path]): Promise<string> {
  const root = await adapters.filesystem.realpath(repositoryRoot)
  const resolved = await adapters.filesystem.realpath(path)
  if (!contained(root, resolved)) throw new Error("Write containment check failed")
  for (const operationPath of operationPaths) {
    const opInput = operationPath.startsWith("/") ? operationPath : `${root}/${operationPath}`
    const op = await adapters.filesystem.realpath(opInput)
    if (!contained(root, op)) throw new Error("Write operation containment check failed")
    const relativePath = op.slice(root.length).replace(/^\//, "") || "."
    for (const scope of protectedPaths) {
      try { if (badPath(scope) || picomatch(scope, { dot: true, nocase: false })(relativePath)) throw new Error("Protected write path") } catch (error) { if (error instanceof Error && error.message === "Protected write path") throw error; throw new Error("Malformed protected path scope") }
    }
  }
  const boundary = (adapters.filesystem as any).beforeWrite
  if (typeof boundary !== "function") throw new Error("Write boundary adapter unavailable")
  const checked = await boundary(resolved, root)
  if (typeof checked === "string" && !contained(root, checked)) throw new Error("Write boundary containment check failed")
  return checked ?? resolved
}

export async function validateCommit(input: Readonly<{ workspace: WorkspaceResult; capabilities: readonly Capability[]; approved: boolean; stagedPaths?: readonly string[]; writeScopes: readonly string[]; protectedPaths?: readonly string[]; protectedBranches?: readonly string[]; branch?: string }>, adapters: WorkspaceAdapters): Promise<Readonly<{ allowed: boolean; reason?: string }>> {
  if (!input.capabilities.includes("git.commit") || !input.approved) return { allowed: false, reason: "Commit approval required" }
  if (!input.branch || (input.protectedBranches ?? ["main", "master", "protected/**"]).some((pattern) => { try { return badPath(pattern) || picomatch(pattern, { dot: true, nocase: false })(input.branch!) } catch { return true } })) return { allowed: false, reason: "Protected branch" }
  const fresh = await status(adapters.git, input.workspace.path)
  if (typeof adapters.git.stagedPaths !== "function") return { allowed: false, reason: "Fresh staged-path evidence unavailable" }
  const staged = await adapters.git.stagedPaths(input.workspace.path)
  if (!Array.isArray(staged) || staged.some((path: unknown) => typeof path !== "string")) return { allowed: false, reason: "Fresh staged-path evidence unavailable" }
  const checked = validateStagedPaths(staged, input.writeScopes, input.protectedPaths)
  if (!checked.allowed || fresh.clean === false) return { allowed: false, reason: checked.reason ?? "Workspace has unrecorded changes" }
  await assertWriteBoundary(input.workspace.path, input.workspace.repositoryRoot, adapters, input.protectedPaths, staged)
  return { allowed: true }
}
