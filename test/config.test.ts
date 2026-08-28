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
    "swarm-researcher",
    "swarm-reviewer",
    "swarm-tester",
    "workflow-director",
  ])
  expect(Object.keys(config.command ?? {})).toEqual(["swarm"])
})

test("preserves colliding user definitions", () => {
  const existingAgent = {
    description: "User-owned director",
    mode: "primary" as const,
    prompt: "Keep this agent unchanged.",
  }
  const existingCommand = {
    template: "Keep this command unchanged.",
    description: "User-owned command",
  }
  const config: Config = {
    agent: { "workflow-director": existingAgent },
    command: { swarm: existingCommand },
  }

  applyNativeSwarmsConfig(config)

  expect(config.agent?.["workflow-director"]).toBe(existingAgent)
  expect(config.command?.swarm).toBe(existingCommand)
  expect(Object.keys(config.agent ?? {})).toHaveLength(4)
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
  expect(permission).not.toHaveProperty("bash")
  expect(permission).not.toHaveProperty("task")
})

test("limits the reviewer to approved read-only git commands", () => {
  const config: Config = {}
  applyNativeSwarmsConfig(config)

  const bash = permissionsFor(config, "swarm-reviewer").bash

  expect(bash).toEqual({
    "*": "deny",
    "git status*": "allow",
    "git diff*": "allow",
    "git log*": "allow",
    "git show*": "allow",
    "git branch --show-current*": "allow",
    "git rev-parse*": "allow",
  })
})

test("limits the tester to approved git and test command families", () => {
  const config: Config = {}
  applyNativeSwarmsConfig(config)

  const bash = permissionsFor(config, "swarm-tester").bash as Record<string, string>

  expect(Object.keys(bash)).toHaveLength(20)
  expect(bash).toEqual({
    "*": "deny",
    "git status*": "allow",
    "git diff*": "allow",
    "git log*": "allow",
    "git show*": "allow",
    "git branch --show-current*": "allow",
    "git rev-parse*": "allow",
    "npm test*": "allow",
    "npm run test*": "allow",
    "npm run lint*": "allow",
    "npm run typecheck*": "allow",
    "pnpm test*": "allow",
    "pnpm run test*": "allow",
    "pnpm lint*": "allow",
    "pnpm typecheck*": "allow",
    "bun test*": "allow",
    "pytest*": "allow",
    "python -m pytest*": "allow",
    "cargo test*": "allow",
    "go test*": "allow",
  })
})

test("protects environment and secrets files for every swarm agent", () => {
  const config: Config = {}
  applyNativeSwarmsConfig(config)

  for (const agent of Object.keys(config.agent ?? {})) {
    const read = permissionsFor(config, agent).read

    expect(read).toMatchObject({
      "*": "allow",
      ".env": "deny",
      ".env.*": "deny",
      "*.env": "deny",
      "*.env.*": "deny",
      ".env.example": "allow",
      "*.env.example": "allow",
      "secrets/**": "deny",
    })
  }
})

test("inherits models from OpenCode configuration", () => {
  const config: Config = {}
  applyNativeSwarmsConfig(config)

  for (const agent of Object.values(config.agent ?? {})) {
    expect(agent).not.toHaveProperty("model")
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
})
