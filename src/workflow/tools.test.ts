import { expect, test } from "bun:test"
import { createWorkflowTools } from "./tools"
import { validateWorkflowCommand } from "./commands-ui"

const context = (overrides: Record<string, unknown> = {}) => ({
  sessionID: "parent", messageID: "m", agent: "user", directory: "/repo", worktree: "/repo",
  abort: new AbortController().signal, metadata() {}, ask: async () => {}, ...overrides,
}) as any

test("registers the complete workflow tool surface", () => {
  const runtime = Object.fromEntries(["status", "wait", "cancel", "amend", "resume", "cleanup", "launch"].map((name) => [name, async () => ({ runId: "r" })])) as any
  const tools = createWorkflowTools({ runtime })
  expect(Object.keys(tools).sort()).toEqual(["workflow_amend", "workflow_cancel", "workflow_cleanup", "workflow_command", "workflow_inspect", "workflow_launch", "workflow_resume", "workflow_save", "workflow_status", "workflow_validate", "workflow_wait"].sort())
})

test("delegates lifecycle calls and scopes command to the bound session", async () => {
  const calls: string[] = []
  const runtime = {
    status: async (id: string) => { calls.push(`status:${id}`); return { runId: id } },
    wait: async (id: string) => { calls.push(`wait:${id}`); return { runId: id } },
    cancel: async (id: string) => { calls.push(`cancel:${id}`); return { runId: id } },
    binding: (id: string) => id === "child" ? { runId: "r", stepId: "s", sessionID: id, policyHash: "p" } : undefined,
  } as any
  const tools = createWorkflowTools({ runtime })
  await tools.workflow_status.execute({ runId: "r" }, context())
  await tools.workflow_wait.execute({ runId: "r", timeoutMs: 10 }, context())
  await tools.workflow_cancel.execute({ runId: "r" }, context())
  await expect(tools.workflow_command.execute({ sessionID: "parent", runID: "r", stepID: "s", command: { executable: "bun", argv: [], cwd: ".", env: [] } }, context())).rejects.toThrow()
  expect(calls).toEqual(["status:r", "wait:r", "cancel:r"])
})

test("approval broker requests workflow permission and denies a missing reply", async () => {
  const asks: any[] = []
  const tools = createWorkflowTools({ runtime: { launch: async () => ({ runId: "r" }) } as any, approvalTimeoutMs: 5 })
  const promise = tools.workflow_launch.execute({ workflow: { schemaVersion: 1, name: "x", steps: [] } }, context({ ask: async (input: any) => asks.push(input) }))
  expect((await promise as any).output).toMatch(/timed out|denied/i)
  expect(asks[0].permission).toBe("workflow.launch")
})

test("approval broker observes abort and ignores duplicate replies", async () => {
  const controller = new AbortController()
  let metadata: any
  const broker = (await import("./tools")).createApprovalBroker({ timeoutMs: 1000 })
  const pending = broker.request({ workflowHash: "a", policyHash: "b", capabilities: [], modes: [], commands: [], reasons: [] }, "s", context({ abort: controller.signal, ask: async (input: any) => { metadata = input.metadata; broker.permissionAsk({ metadata, id: "p" }, { status: "ask" }) } }))
  controller.abort()
  expect((await pending).decision.allowed).toBe(false)
  broker.event({ type: "permission.replied", permissionID: "p", status: "allow" })
  expect(broker.pending()).toBe(0)
})

test("workflow_command validates structured command input before execution", async () => {
  const runtime = { binding: () => ({ runId: "r", stepId: "s", sessionID: "child", policyHash: "p" }) } as any
  const tools = createWorkflowTools({ runtime, command: async () => "executed" })
  await expect(tools.workflow_command.execute({ sessionID: "child", runID: "r", stepID: "s", command: "bun run check" }, context({ sessionID: "child" }))).rejects.toThrow()
})

test("workflow_command invokes the bound command executor with token and exact scope", async () => {
  let received: any
  const runtime = { binding: () => ({ runId: "r", stepId: "s", sessionID: "child", policyHash: "p" }) } as any
  const tools = createWorkflowTools({ runtime, commandBinding: async (input) => { received = input; return { allowed: true } } })
  await tools.workflow_command.execute({ sessionID: "child", runID: "r", stepID: "s", approvalToken: "token", command: { executable: "bun", argv: ["run", "check"], cwd: ".", env: [] } }, context({ sessionID: "child" }))
  expect(received.approvalToken).toBe("token")
  expect(received.command.executable).toBe("bun")
  expect(received.policyHash).toBe("p")
})

test("workflow_command rejects mismatched approved argv or token", async () => {
  const runtime = { binding: () => ({ runId: "r", stepId: "s", sessionID: "child", policyHash: "p", approvedCommand: { executable: "bun", argv: ["run", "check"], cwd: ".", env: [] }, approvalToken: "good" }) } as any
  const tools = createWorkflowTools({ runtime, commandBinding: async () => "executed" })
  const base = { sessionID: "child", runID: "r", stepID: "s", command: { executable: "bun", argv: ["run", "check"], cwd: ".", env: [] } }
  await expect(tools.workflow_command.execute({ ...base, approvalToken: "bad" }, context({ sessionID: "child" }))).rejects.toThrow(/token/i)
  await expect(tools.workflow_command.execute({ ...base, approvalToken: "good", command: { ...base.command, argv: ["run", "test"] } }, context({ sessionID: "child" }))).rejects.toThrow(/command/i)
})

test("workflow command accepts lifecycle verbs and stable run-id errors", () => {
  for (const verb of ["validate", "run", "status", "cancel", "resume", "cleanup"] as const) expect(validateWorkflowCommand(`${verb}${["status", "cancel", "resume", "cleanup"].includes(verb) ? " run_1" : ""}`).subcommand).toBe(verb)
  expect(() => validateWorkflowCommand("status bad/id")).toThrow("Malformed workflow run ID")
  expect(() => validateWorkflowCommand("unknown")).toThrow("Unknown /workflow subcommand")
})
