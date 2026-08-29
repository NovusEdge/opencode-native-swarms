import type { Plugin } from "@opencode-ai/plugin"
import { applyNativeSwarmsConfig } from "./config"
import { nativeSwarmGitInspectTool } from "./git"
import { nativeSwarmReadTool } from "./read"
import { nativeSwarmSearchTool } from "./search"
import { createWorkflowTools, createApprovalBroker } from "./workflow/tools"
import { validateWorkflowCommand } from "./workflow/commands-ui"

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

export const NativeSwarmsPlugin: Plugin = async () => {
  const broker = createApprovalBroker()
  const workflowTools = createWorkflowTools({ runtime: unavailableRuntime, broker })
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
  "command.execute.before": async (input, output) => {
    if (input.command !== "workflow") return
    const parsed = validateWorkflowCommand(input.arguments)
    output.parts.push({ type: "text", text: `${parsed.subcommand}${parsed.arguments ? ` ${parsed.arguments}` : ""}` } as any)
  },
  }
}
