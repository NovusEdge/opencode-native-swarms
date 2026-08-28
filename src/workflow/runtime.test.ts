import { describe, expect, test } from "bun:test"
import { createWorkflowRuntime, RESERVED_AGENT } from "./runtime"

const hash = "a".repeat(64)
const plan = (steps: any[], maxConcurrency = 1): any => ({ definition: { name: "test", failurePolicy: "fail-fast", maxConcurrency, steps }, steps, policyHash: hash, workflowHash: hash, maxConcurrency })
function harness() {
  const records = new Map<string, any>()
  const sessions = new Map<string, { status: any; messages: any[] }>()
  let id = 0
  const state: any = { write: async (id: string, r: any) => records.set(id, structuredClone(r)), read: async (id: string) => records.get(id), listRuns: async () => [...records.values()], resume: async (id: string) => records.get(id) }
  const adapter: any = {
    create: async () => { const sessionID = `s-${++id}`; sessions.set(sessionID, { status: { type: "completed" }, messages: [{ role: "assistant", parts: [{ text: JSON.stringify({ value: "ok" }) }] }] }); return { sessionID } },
    promptAsync: async () => {}, status: async (id: string) => sessions.get(id)!.status, abort: async () => {}, messages: async (id: string) => sessions.get(id)!.messages,
  }
  return { records, adapter, state }
}
const step = (id: string, dependsOn: string[] = []): any => ({ id, prompt: `do ${id}`, dependsOn, model: { mode: "inherit" }, workspace: { mode: "read-only" }, permissions: { capabilities: [], deny: [], readPaths: [], writePaths: [] }, commands: [], inputs: [], outputs: [{ name: "value", type: "text", required: true }], limits: { timeoutSeconds: 1, maxOutputBytes: 1000, maxChildAgents: 0 } })
const approval: any = { token: "t", workflowHash: hash, policyHash: hash, singleUse: true, summary: {} }

describe("workflow runtime", () => {
  test("launches asynchronously and schedules dependencies", async () => {
    const h = harness(); const runtime = createWorkflowRuntime({ state: h.state, sessions: h.adapter, registerToolHook: () => {}, agent: { name: RESERVED_AGENT, definition: { permission: { bash: "deny", read: "deny" }, tools: ["workflow_command"] } } })
    const launched = await runtime.launch(plan([step("a")]), approval)
    expect(launched.runId).toBeString()
    const result = await runtime.wait(launched.runId, 0)
    expect(result.runId).toBe(launched.runId)
  })
  test("rejects built-in tools for a bound session", async () => {
    const h = harness(); const runtime = createWorkflowRuntime({ state: h.state, sessions: h.adapter, registerToolHook: () => {}, agent: { name: RESERVED_AGENT, definition: { permission: { bash: "deny" }, tools: ["workflow_command"] } } })
    const { runId } = await runtime.launch(plan([step("a")]), approval)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const record = await runtime.status(runId); const sessionID = record.steps[0].sessionID!
    expect(() => runtime.beforeTool(sessionID, "bash")).toThrow()
  })
  test("fails closed when host hook is unavailable", async () => {
    const h = harness(); const runtime = createWorkflowRuntime({ state: h.state, sessions: h.adapter, agent: { name: RESERVED_AGENT, definition: { permission: { bash: "deny" }, tools: ["workflow_command"] } } })
    await expect(runtime.launch(plan([step("a")]), approval)).rejects.toThrow()
  })
  test("rejects approval replay across runtime instances", async () => {
    const h = harness(); const opts: any = { state: h.state, sessions: h.adapter, registerToolHook: () => {}, agent: { name: RESERVED_AGENT, definition: { permission: { bash: "deny" }, tools: ["workflow_command"] } } }
    await createWorkflowRuntime(opts).launch(plan([step("a")]), approval)
    await expect(createWorkflowRuntime(opts).launch(plan([step("a")]), approval)).rejects.toThrow()
  })
})
