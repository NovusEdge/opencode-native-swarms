import { describe, expect, test } from "bun:test"
import { assertWriteBoundary, checkWriterOverlap, cleanupWorkspace, commitWorkspace, resolveWorkspace, validateStagedPaths, verifyWriterHandoff } from "./workspace"

const fs = (paths: Record<string, string> = {}) => ({
  realpath: async (p: string) => paths[p] ?? p,
  atomicWrite: async () => {}, read: async () => "", isSymlink: async () => false,
  acquireLock: async () => ({ release: async () => {} }),
})
const git = (extra: Record<string, unknown> = {}) => ({
  repositoryIdentity: async () => "repo-1", status: async () => ({ clean: true, snapshot: "s1" }),
  ...extra,
})

describe("workspace safety", () => {
  test("resolves read-only repository-relative workspace", async () => {
    const result = await resolveWorkspace({ mode: "read-only", repositoryRoot: "/repo", repositoryId: "repo-1" }, { filesystem: fs(), git: git() })
    expect(result.path).toBe("/repo")
    expect(result.mode).toBe("read-only")
  })

  test("rejects symlink escape and identity mismatch", async () => {
    await expect(resolveWorkspace({ mode: "read-only", repositoryRoot: "/repo", path: "link", repositoryId: "repo-1" }, { filesystem: fs({ "/repo/link": "/outside" }), git: git() })).rejects.toThrow(/containment/)
    await expect(resolveWorkspace({ mode: "read-only", repositoryRoot: "/repo", repositoryId: "repo-1" }, { filesystem: fs(), git: git({ repositoryIdentity: async () => "other" }) })).rejects.toThrow(/identity/)
  })

  test("requires current write approvals and clean precondition", async () => {
    await expect(resolveWorkspace({ mode: "current", repositoryRoot: "/repo", repositoryId: "repo-1", write: true }, { filesystem: fs(), git: git() })).rejects.toThrow(/approval/)
    await expect(resolveWorkspace({ mode: "current", repositoryRoot: "/repo", repositoryId: "repo-1", write: true, workflowSelectsCurrent: true, installationAllowsWrites: true, launchApprovesWrites: true, approvalOperation: "workspace.patch", capabilities: ["workspace.patch"], requireClean: true }, { filesystem: fs(), git: git({ status: async () => ({ clean: false }) }) })).rejects.toThrow(/clean/)
  })

  test("rejects parallel overlap but allows explicit sequential handoff", () => {
    expect(checkWriterOverlap([{ step: "a", scopes: ["src/**"] }], { step: "b", scopes: ["src/x.ts"] })).toMatchObject({ allowed: false })
    expect(checkWriterOverlap([{ step: "a", scopes: ["src/**"] }], { step: "b", scopes: ["src/x.ts"], dependsOn: ["a"], handoff: { workspaceIdentity: "repo-1", expectedTree: "tree" } })).toMatchObject({ allowed: true })
  })

  test("validates staged paths and refuses unsafe cleanup", async () => {
    expect(validateStagedPaths(["src/a.ts", ".env"], ["src/**"], [".env"])).toMatchObject({ allowed: false })
    const result = await cleanupWorkspace({ path: "/repo", managed: true, failed: true, status: { clean: false } }, { filesystem: fs(), git: git() })
    expect(result.cleaned).toBe(false)
    const dirty = await cleanupWorkspace({ path: "/repo", managed: true, repositoryRoot: "/repo", repositoryId: "repo-1" }, { filesystem: fs(), git: git({ status: async () => ({ clean: false }) }) })
    expect(dirty.cleaned).toBe(false)
    expect(dirty.reason).toMatch(/unrecorded|unpushed|dirty/i)
  })

  test("rejects public absolute paths and protected final targets", async () => {
    await expect(resolveWorkspace({ mode: "read-only", repositoryRoot: "/repo", repositoryId: "repo-1", path: "/outside" }, { filesystem: fs(), git: git() })).rejects.toThrow(/path/)
    const guarded = { ...fs(), beforeWrite: async () => "/repo/.env" }
    await expect(assertWriteBoundary("/repo/src/a.ts", "/repo", { filesystem: guarded, git: git() }, [".env"], ["src/a.ts"])).rejects.toThrow(/Protected/)
    const escaping = { ...fs({ "/repo/link": "/outside" }), beforeWrite: async () => "/repo/link" }
    await expect(assertWriteBoundary("/repo/src/a.ts", "/repo", { filesystem: escaping, git: git() }, [], ["src/a.ts"])).rejects.toThrow(/containment/)
  })

  test("commit requires fresh staged evidence and invokes adapter at boundary", async () => {
    const commits: unknown[] = []
    const adapters = { filesystem: { ...fs(), beforeWrite: async (path: string) => path }, git: git({ branch: async () => "feature/x", stagedPaths: async () => ["src/a.ts"], commit: async (...args: unknown[]) => { commits.push(args); return "c1" } }) }
    const workspace = { mode: "worktree" as const, path: "/repo", repositoryRoot: "/repo", repositoryId: "repo-1", managed: true }
    const result = await commitWorkspace({ workspace, capabilities: ["git.commit"], approved: true, writeScopes: ["src/**"], message: "ok" }, adapters)
    expect(result.allowed).toBe(true)
    expect(commits).toHaveLength(1)
  })

  test("handoff verifies fresh identity and tree", async () => {
    const workspace = { mode: "current" as const, path: "/repo", repositoryRoot: "/repo", repositoryId: "repo-1", managed: false }
    const result = await verifyWriterHandoff({ workspaceIdentity: "repo-1", expectedTree: "tree-1" }, workspace, { filesystem: fs(), git: git({ status: async () => ({ clean: true, tree: "tree-2" }) }) })
    expect(result.allowed).toBe(false)
    const identityMismatch = await verifyWriterHandoff({ workspaceIdentity: "repo-1", expectedTree: "tree-1" }, { ...workspace, repositoryId: "repo-2" }, { filesystem: fs(), git: git({ status: async () => ({ clean: true, tree: "tree-1" }) }) })
    expect(identityMismatch.allowed).toBe(false)
  })
})
