import type { Plugin } from "@opencode-ai/plugin"
import { applyNativeSwarmsConfig } from "./config"

export const NativeSwarmsPlugin: Plugin = async () => ({
  config: async (config) => {
    applyNativeSwarmsConfig(config)
  },
})
