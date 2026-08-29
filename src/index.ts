import type { Plugin } from "@opencode-ai/plugin"
import { applyNativeSwarmsConfig } from "./config"
import { nativeSwarmGitInspectTool } from "./git"
import { nativeSwarmReadTool } from "./read"
import { nativeSwarmSearchTool } from "./search"
import { createWorkflowTools, createApprovalBroker } from "./workflow/tools"
import { validateWorkflowCommand } from "./workflow/commands-ui"
import { createWorkflowRuntime } from "./workflow/runtime"
import { createRepositoryStateStore } from "./workflow/state"
import { reservedWorkflowAgent } from "./definitions"
import { promises as fs } from "node:fs"

const unavailableRuntime = {
  async launch() { throw new Error("Workflow runtime is unavailable") },
  async status() { throw new Error("Workflow runtime is unavailable") },
  async wait() { throw new Error("Workflow runtime is unavailable") },
  async cancel() { throw new Error("Workflow runtime is unavailable") },
  async amend() { throw new Error("Workflow runtime is unavailable") },
  async resume() { throw new Error("Workflow runtime is unavailable") },
  async cleanup() { throw new Error("Workflow runtime is unavailable") },
  binding() { return undefined },
}

export const NativeSwarmsPlugin: Plugin = async (input) => {
  const broker = createApprovalBroker()
  if (!input?.worktree || !(input as any).client?.session) {
    return { tool: { swarm_git_inspect: nativeSwarmGitInspectTool, swarm_read: nativeSwarmReadTool, swarm_search: nativeSwarmSearchTool, ...createWorkflowTools({ runtime: unavailableRuntime, broker }) }, config: async (config) => { applyNativeSwarmsConfig(config) } }
  }
  const client: any = input.client as any
  const sessions = {
    async create(x: any) { const r = await client.session.create({ body: { title: x.title }, query: { directory: x.directory } }); return { sessionID: r.data?.id ?? r.id } },
    async promptAsync(x: any) { await client.session.promptAsync({ path: { id: x.sessionID }, body: { agent: x.agent, system: x.system, parts: x.parts } }) },
    async status(id: string) { const r = await client.session.status({ path: { id } }); return r.data ?? r },
    async abort(id: string) { await client.session.abort({ path: { id } }) },
    async messages(id: string) { const r = await client.session.messages({ path: { id } }); return r.data ?? r },
  }
  const filesystem: any = { realpath: (p: string) => fs.realpath(p), atomicWrite: async (p: string, d: string) => { await fs.mkdir((await import("node:path")).dirname(p), { recursive: true }); await fs.writeFile(p, d) }, read: (p: string) => fs.readFile(p, "utf8"), isSymlink: async () => false, acquireLock: async (p: string) => { await fs.mkdir((await import("node:path")).dirname(p), { recursive: true }); return { release: async () => {} } } }
  const state = createRepositoryStateStore({ filesystem, environment: { get: (name) => process.env[name], homeDirectory: () => process.env.HOME ?? "" }, repository: { commonDirectory: input.worktree, metadata: { project: (input.project as any)?.id ?? input.directory } } })
  let runtimeGuard: ((input: { sessionID: string; tool: string }) => void) | undefined
  const runtime = createWorkflowRuntime({ state, sessions, repositoryRoot: input.worktree, repositoryId: (input.project as any)?.id ?? input.directory, agent: { name: "native-swarms-workflow-step", definition: reservedWorkflowAgent }, registerToolHook: (hook) => { runtimeGuard = hook }, consumeApproval: (token, workflowHash, policyHash) => broker.consume(token, workflowHash, policyHash) })
  const workflowTools = createWorkflowTools({ runtime, broker })
  return {
    tool: {
    swarm_git_inspect: nativeSwarmGitInspectTool,
    swarm_read: nativeSwarmReadTool,
    swarm_search: nativeSwarmSearchTool,
    ...workflowTools,
  },
  config: async (config) => {
    applyNativeSwarmsConfig(config)
  },
  "permission.ask": async (input, output) => { broker.permissionAsk(input, output) },
  event: async (input) => { broker.event(input) },
  "tool.execute.before": async (input) => { runtimeGuard?.(input) },
  "command.execute.before": async (input, output) => {
    if (input.command !== "workflow") return
    const parsed = validateWorkflowCommand(input.arguments)
    output.parts.push({ type: "text", text: `${parsed.subcommand}${parsed.arguments ? ` ${parsed.arguments}` : ""}` } as any)
  },
  }
}
