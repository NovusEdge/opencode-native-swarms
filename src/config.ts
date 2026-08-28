import type { Config } from "@opencode-ai/plugin"
import { nativeSwarmAgents, nativeSwarmCommands } from "./definitions"

export function applyNativeSwarmsConfig(config: Config): void {
  config.agent ??= {}
  config.command ??= {}

  for (const [name, definition] of Object.entries(nativeSwarmAgents)) {
    // The plugin's v1 Config type predates OpenCode's generalized permission map.
    if (!(name in config.agent)) {
      config.agent[name] = structuredClone(definition) as NonNullable<Config["agent"]>[string]
    }
  }

  for (const [name, definition] of Object.entries(nativeSwarmCommands)) {
    if (!(name in config.command)) config.command[name] = structuredClone(definition)
  }
}
