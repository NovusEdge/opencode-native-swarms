import { describe, expect, test } from "bun:test"
import { checkWriterOverlap, cleanupWorkspace, resolveWorkspace, validateStagedPaths } from "./workspace"

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
    await expect(resolveWorkspace({ mode: "current", repositoryRoot: "/repo", repositoryId: "repo-1", write: true, workflowSelectsCurrent: true, installationAllowsWrites: true, launchApprovesWrites: true, capabilities: ["workspace.patch"], requireClean: true }, { filesystem: fs(), git: git({ status: async () => ({ clean: false }) }) })).rejects.toThrow(/clean/)
  })

  test("rejects parallel overlap but allows explicit sequential handoff", () => {
    expect(checkWriterOverlap([{ step: "a", scopes: ["src/**"] }], { step: "b", scopes: ["src/x.ts"] })).toMatchObject({ allowed: false })
    expect(checkWriterOverlap([{ step: "a", scopes: ["src/**"] }], { step: "b", scopes: ["src/x.ts"], dependsOn: ["a"], handoff: true })).toMatchObject({ allowed: true })
  })

  test("validates staged paths and refuses unsafe cleanup", async () => {
    expect(validateStagedPaths(["src/a.ts", ".env"], ["src/**"], [".env"])).toMatchObject({ allowed: false })
    const result = await cleanupWorkspace({ path: "/repo", managed: true, failed: true, status: { clean: false } }, { filesystem: fs(), git: git() })
    expect(result.cleaned).toBe(false)
  })
})
