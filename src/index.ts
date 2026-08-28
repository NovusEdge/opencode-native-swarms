import type { Plugin } from "@opencode-ai/plugin"
import { applyNativeSwarmsConfig } from "./config"
import { nativeSwarmGitInspectTool } from "./git"
import { nativeSwarmReadTool } from "./read"
import { nativeSwarmSearchTool } from "./search"

export const NativeSwarmsPlugin: Plugin = async () => ({
  tool: {
    swarm_git_inspect: nativeSwarmGitInspectTool,
    swarm_read: nativeSwarmReadTool,
    swarm_search: nativeSwarmSearchTool,
  },
  config: async (config) => {
    applyNativeSwarmsConfig(config)
  },
})
