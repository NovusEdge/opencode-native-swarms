import type { Plugin } from "@opencode-ai/plugin"
import { applyNativeSwarmsConfig } from "./config"
import { nativeSwarmGitInspectTool } from "./git"

export const NativeSwarmsPlugin: Plugin = async () => ({
  tool: {
    swarm_git_inspect: nativeSwarmGitInspectTool,
  },
  config: async (config) => {
    applyNativeSwarmsConfig(config)
  },
})
