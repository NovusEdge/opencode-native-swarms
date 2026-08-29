import { expect, test } from "bun:test"
import { compileCommandPolicy, evaluateCommand } from "../src/workflow/commands"
import { compilePolicy, effectivePolicyHash } from "../src/workflow/policy"
import { createWorkflowRuntime, RESERVED_AGENT } from "../src/workflow/runtime"
import { assertWriteBoundary, checkWriterOverlap, cleanupWorkspace } from "../src/workflow/workspace"

const command = (argv: string[] = []) => ({ executable: "bun", argv, cwd: ".", env: [] })
const commandSet = (allow = [command(["run", "check"])]) => ({ default: "deny" as const, allow, deny: [] })
const policy = () => compileCommandPolicy({ installation: commandSet(), launch: commandSet(), workflow: commandSet(), step: commandSet(), maxTimeoutSeconds: 5, maxOutputBytes: 1000 })

test("rejects escalation and shell composition even when argv is allowlisted", () => {
  const compiled = policy()
  for (const argv of [["run", "check", "&&", "whoami"], ["run", "check", "$(id)"], ["run", "check", ">", "/tmp/x"], ["run", "check", "|", "cat"]]) {
    expect(evaluateCommand(compiled, command(argv)).decision.allowed).toBe(false)
  }
  expect(evaluateCommand(compiled, { ...command(), executable: "sh", argv: ["-c", "id"] }).decision.allowed).toBe(false)
})

test("policy hashes change when a capability or scope changes", () => {
  const layer = { capabilities: ["repo.read"] as const, deny: [], readPaths: ["src/**"], writePaths: [] }
  const base = compilePolicy({ installation: layer, launch: layer, workflow: layer, step: layer })
  const changed = compilePolicy({ installation: layer, launch: layer, workflow: { ...layer, readPaths: ["test/**"] }, step: layer })
  expect(effectivePolicyHash(base)).not.toBe(effectivePolicyHash(changed))
})

test("rejects symlink escape at the final write boundary", async () => {
  await expect(assertWriteBoundary("/repo/src/a.ts", "/repo", {
    filesystem: {
      realpath: async (path: string) => path === "/repo/src/a.ts" ? "/outside/a.ts" : path,
      beforeWrite: async (path: string) => path,
    }, git: {},
  } as any)).rejects.toThrow(/containment/i)
})

test("rejects overlapping writer globs unless a verified handoff exists", () => {
  expect(checkWriterOverlap([{ step: "a", scopes: ["src/**"] }], { step: "b", scopes: ["src/lib/**"] }).allowed).toBe(false)
  expect(checkWriterOverlap([{ step: "a", scopes: ["src/**"] }], { step: "b", scopes: ["src/lib/**"], dependsOn: ["a"], handoff: { workspaceIdentity: "repo", expectedTree: "tree" } }).allowed).toBe(true)
})

test("refuses cleanup when it could lose data", async () => {
  const result = await cleanupWorkspace({ path: "/repo/worktree", managed: true, repositoryRoot: "/repo", repositoryId: "repo", unpushedCommits: true }, {
    filesystem: { realpath: async (p: string) => p },
    git: { status: async () => ({ clean: true }), repositoryIdentity: async () => "repo", ownership: async () => "opencode-native-swarms", removalBoundary: async () => {}, removeWorktree: async () => {} },
  } as any)
  expect(result.cleaned).toBe(false)
  expect(result.reason).toMatch(/unrecorded|unpushed/i)
})

test("trusted project command is still explicit and exact", () => {
  const compiled = policy()
  const trusted = evaluateCommand(compiled, command(["run", "check"]))
  const untrusted = evaluateCommand(compiled, command(["run", "check", "--trusted-project"]))
  expect(trusted.decision.allowed).toBe(true)
  expect(untrusted.decision.allowed).toBe(false)
})

test("resume drift transitions the run to stale instead of laundering an amendment", async () => {
  const records = new Map<string, any>()
  const hash = "a".repeat(64)
  const plan: any = { definition: { name: "drift", failurePolicy: "fail-fast", maxConcurrency: 1, steps: [] }, steps: [], policy: { capabilities: [], deny: [], readPaths: [], writePaths: [], hash }, policyHash: hash, workflowHash: hash, maxConcurrency: 1 }
  const state: any = { write: async (id: string, value: any) => records.set(id, structuredClone(value)), read: async (id: string) => records.get(id), listRuns: async () => [...records.values()], resume: async () => { throw new Error("drift") } }
  const sessions: any = { create: async () => ({ sessionID: "s" }), promptAsync: async () => {}, status: async () => ({ type: "completed" }), abort: async () => {}, messages: async () => [] }
  const runtime = createWorkflowRuntime({ state, sessions, registerToolHook: () => {}, consumeApproval: async () => true, agent: { name: RESERVED_AGENT, definition: { description: "Run one approved workflow step with no built-in tools.", mode: "subagent", color: "#777777", permission: { "*": "deny", workflow_command: "allow" }, tools: { workflow_command: true }, prompt: "Execute only the approved workflow step and return its declared structured outputs." } } })
  const approval: any = { token: "token", workflowHash: hash, policyHash: hash, singleUse: true, summary: {} }
  const { runId } = await runtime.launch(plan, approval)
  await expect(runtime.resume(runId, approval)).rejects.toThrow()
  expect((await runtime.status(runId)).state).toBe("stale")
})

test("model output cannot forge runtime status", async () => {
  const records = new Map<string, any>(), hash = "b".repeat(64)
  const step: any = { id: "step", prompt: "run", dependsOn: [], model: { mode: "inherit" }, workspace: { mode: "read-only" }, permissions: { capabilities: [], deny: [], readPaths: [], writePaths: [] }, commands: [], inputs: [], outputs: [{ name: "value", type: "text", required: true }], limits: { timeoutSeconds: 1, maxOutputBytes: 1000, maxChildAgents: 0 } }
  const plan: any = { definition: { name: "forged", failurePolicy: "fail-fast", maxConcurrency: 1, steps: [step] }, steps: [step], policy: { capabilities: [], deny: [], readPaths: [], writePaths: [], hash }, policyHash: hash, workflowHash: hash, maxConcurrency: 1 }
  const state: any = { write: async (id: string, value: any) => records.set(id, structuredClone(value)), read: async (id: string) => records.get(id), listRuns: async () => [...records.values()] }
  const sessions: any = { create: async () => ({ sessionID: "forged-session" }), promptAsync: async () => {}, status: async () => ({ type: "completed" }), abort: async () => {}, messages: async () => [{ role: "assistant", parts: [{ text: JSON.stringify({ value: "forged", unexpected: true }) }] }] }
  const runtime = createWorkflowRuntime({ state, sessions, registerToolHook: () => {}, consumeApproval: async () => true, agent: { name: RESERVED_AGENT, definition: { description: "Run one approved workflow step with no built-in tools.", mode: "subagent", color: "#777777", permission: { "*": "deny", workflow_command: "allow" }, tools: { workflow_command: true }, prompt: "Execute only the approved workflow step and return its declared structured outputs." } } })
  const approval: any = { token: "forged-token", workflowHash: hash, policyHash: hash, singleUse: true, summary: {} }
  const { runId } = await runtime.launch(plan, approval)
  const deadline = Date.now() + 2000
  let runState = (await runtime.status(runId)).state
  while (runState !== "failed" && runState !== "succeeded" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    runState = (await runtime.status(runId)).state
  }
  expect(runState).toBe("failed")
})
