import { expect, test } from "bun:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"
import { applyNativeSwarmsConfig } from "../src/config"
import { NativeSwarmsPlugin } from "../src/index"

type PermissionMap = Record<string, string | Record<string, string>>

function permissionsFor(config: Config, agent: string): PermissionMap {
  return config.agent?.[agent]?.permission as PermissionMap
}

test("adds native swarm agents and command to an empty config", () => {
  const config: Config = {}

  applyNativeSwarmsConfig(config)

  expect(Object.keys(config.agent ?? {}).sort()).toEqual([
    "native-swarms-workflow-step",
    "swarm-researcher",
    "swarm-reviewer",
    "swarm-tester",
    "workflow-director",
  ])
  expect(Object.keys(config.command ?? {}).sort()).toEqual(["swarm", "workflow"])
})

test("preserves colliding user definitions", () => {
  const agentNames = [
    "native-swarms-workflow-step",
    "workflow-director",
    "swarm-researcher",
    "swarm-reviewer",
    "swarm-tester",
  ] as const
  const existingAgents = Object.fromEntries(
    agentNames.map((name) => [
      name,
      {
        description: `User-owned ${name}`,
        mode: "primary" as const,
        prompt: "Keep this agent unchanged.",
      },
    ]),
  )
  const existingCommand = {
    template: "Keep this command unchanged.",
    description: "User-owned command",
  }
  const existingWorkflow = {
    template: "Keep this workflow command unchanged.",
    description: "User-owned workflow command",
  }
  const config: Config = {
    agent: existingAgents,
    command: { swarm: existingCommand, workflow: existingWorkflow },
  }

  applyNativeSwarmsConfig(config)

  for (const name of agentNames) {
    expect(config.agent?.[name]).toBe(existingAgents[name])
  }
  expect(config.command?.swarm).toBe(existingCommand)
  expect(config.command?.workflow).toBe(existingWorkflow)
  expect(Object.keys(config.agent ?? {})).toHaveLength(5)
})

test("creates isolated definitions for each config application", () => {
  const first: Config = {}
  const second: Config = {}

  applyNativeSwarmsConfig(first)
  const firstDirector = first.agent?.["workflow-director"]
  const firstPermission = permissionsFor(first, "workflow-director")
  firstPermission.question = "deny"

  applyNativeSwarmsConfig(second)

  expect(second.agent?.["workflow-director"]).not.toBe(firstDirector)
  expect(permissionsFor(second, "workflow-director").question).toBe("allow")
})

test("limits director delegation to the three swarm workers", () => {
  const config: Config = {}
  applyNativeSwarmsConfig(config)

  const task = permissionsFor(config, "workflow-director").task

  expect(task).toEqual({
    "*": "deny",
    "swarm-researcher": "allow",
    "swarm-reviewer": "allow",
    "swarm-tester": "allow",
  })
})

test("gives the researcher web access without shell or delegation", () => {
  const config: Config = {}
  applyNativeSwarmsConfig(config)

  const permission = permissionsFor(config, "swarm-researcher")

  expect(permission.webfetch).toBe("allow")
  expect(permission.websearch).toBe("allow")
  expect(permission.grep).toBe("deny")
  expect(permission.swarm_search).toBe("allow")
  expect(permission).not.toHaveProperty("bash")
  expect(permission).not.toHaveProperty("task")
})

test("gives the reviewer hardened git inspection without shell access", () => {
  const config: Config = {}
  applyNativeSwarmsConfig(config)

  const permission = permissionsFor(config, "swarm-reviewer")

  expect(permission.swarm_git_inspect).toBe("allow")
  expect(permission.swarm_search).toBe("allow")
  expect(permission.grep).toBe("deny")
  expect(permission.bash).toBe("deny")
})

test("limits the tester shell to approved test command families", () => {
  const config: Config = {}
  applyNativeSwarmsConfig(config)

  const permission = permissionsFor(config, "swarm-tester")
  const bash = permission.bash as Record<string, string>

  expect(permission.swarm_git_inspect).toBe("allow")
  expect(permission.swarm_search).toBe("allow")
  expect(permission.grep).toBe("deny")
  expect(Object.keys(bash)).toHaveLength(16)
  expect(bash).toEqual({
    "*": "deny",
    "npm test": "allow",
    "npm run test": "allow",
    "npm run lint": "allow",
    "npm run typecheck": "allow",
    "bun run check": "allow",
    "bun run typecheck": "allow",
    "pnpm test": "allow",
    "pnpm run test": "allow",
    "pnpm lint": "allow",
    "pnpm typecheck": "allow",
    "bun test": "allow",
    "pytest": "allow",
    "python -m pytest": "allow",
    "cargo test": "allow",
    "go test ./...": "allow",
  })
})

test("does not broaden Bun script permissions", () => {
  const config: Config = {}
  applyNativeSwarmsConfig(config)
  const bash = permissionsFor(config, "swarm-tester").bash as Record<string, string>

  expect(bash["*"]).toBe("deny")
  expect(bash["bun run check --watch"]).toBeUndefined()
  expect(bash["bun run arbitrary-script"]).toBeUndefined()
  expect(bash["bun run check && echo escaped"]).toBeUndefined()
})

test("protects environment and secrets files for every swarm agent", () => {
  const config: Config = {}
  applyNativeSwarmsConfig(config)

  for (const agent of Object.keys(config.agent ?? {}).filter((name) => name !== "native-swarms-workflow-step")) {
    expect(permissionsFor(config, agent).read).toBe("deny")
    expect(permissionsFor(config, agent).swarm_read).toBe("allow")
    expect(permissionsFor(config, agent).lsp).toBe("deny")
  }
  expect(permissionsFor(config, "native-swarms-workflow-step")["*"]).toBe("deny")
})

test("inherits models from OpenCode configuration", () => {
  const config: Config = {}
  applyNativeSwarmsConfig(config)

  for (const agent of Object.values(config.agent ?? {})) {
    expect(agent).not.toHaveProperty("model")
  }
  expect(config.command?.swarm).not.toHaveProperty("model")
})

test("keeps every swarm agent deny-by-default", () => {
  const config: Config = {}
  applyNativeSwarmsConfig(config)

  for (const agent of Object.keys(config.agent ?? {})) {
    expect(permissionsFor(config, agent)["*"]).toBe("deny")
  }
})

test("exports a plugin hook that applies the native swarm config", async () => {
  const hooks = await NativeSwarmsPlugin({} as PluginInput)
  const config: Config = {}

  await hooks.config?.(config)

  expect(config.agent?.["workflow-director"]?.mode).toBe("primary")
  expect(config.agent?.["swarm-researcher"]?.mode).toBe("subagent")
  expect(config.command?.swarm?.agent).toBe("workflow-director")
  expect(config.command?.swarm?.subtask).toBe(false)
  expect(hooks.tool?.swarm_git_inspect).toBeDefined()
  expect(hooks.tool?.swarm_search).toBeDefined()
})
