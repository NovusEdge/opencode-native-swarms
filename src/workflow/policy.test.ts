import { describe, expect, test } from "bun:test"
import type { Capability, PermissionPolicy } from "./types"
import { compilePolicy, decideCapability, decidePath, effectivePolicyHash } from "./policy"

const allow = (capability: Capability, paths: string[]): PermissionPolicy => ({
  capabilities: [capability], deny: [], readPaths: paths, writePaths: [],
})
const layers = (overrides: Partial<Record<"installation" | "launch" | "workflow" | "step", PermissionPolicy>> = {}) => ({
  installation: overrides.installation ?? allow("repo.read", ["**"]),
  launch: overrides.launch ?? allow("repo.read", ["**"]),
  workflow: overrides.workflow ?? allow("repo.read", ["**"]),
  step: overrides.step ?? allow("repo.read", ["**"]),
})

describe("workflow policy compiler", () => {
  test("intersects capability and path scopes", () => {
    const policy = compilePolicy({
      installation: allow("repo.read", ["src/**"]), launch: allow("repo.read", ["**"]),
      workflow: allow("repo.read", ["src/**"]), step: allow("repo.read", ["src/lib/**"]),
    })
    expect(decidePath(policy, "read", "src/lib/a.ts").allowed).toBe(true)
    expect(decidePath(policy, "read", "test/a.ts").allowed).toBe(false)
  })

  test("explicit deny takes precedence and identifies its layer and rule", () => {
    const policy = compilePolicy(layers({ workflow: { ...allow("repo.read", ["**"]), deny: ["repo.read"] } }))
    expect(decideCapability(policy, "repo.read")).toMatchObject({ allowed: false, layer: "workflow", rule: "deny" })
  })

  test("unknown capability is denied", () => {
    const decision = decideCapability(compilePolicy(layers()), "not-a-capability")
    expect(decision.allowed).toBe(false)
    expect(decision.layer).toBeDefined(); expect(decision.rule).toBeDefined()
  })

  test("read and write scopes are independently contained", () => {
    const writable = { capabilities: ["repo.read", "workspace.patch"] as Capability[], deny: [], readPaths: ["src/**"], writePaths: ["src/**"] }
    const policy = compilePolicy({ installation: writable, launch: writable, workflow: writable, step: { ...writable, writePaths: ["src/lib/**"] } })
    expect(decidePath(policy, "read", "src/a.ts").allowed).toBe(true)
    expect(decidePath(policy, "write", "src/a.ts").allowed).toBe(false)
    expect(decidePath(policy, "write", "src/lib/a.ts").allowed).toBe(true)
  })

  test("rejects protected and malformed paths", () => {
    const policy = compilePolicy({ ...layers(), protectedPaths: [".env", "secrets/**"] })
    for (const path of [".env", "secrets/key", "/etc/passwd", "../x", "a\\b", "a\0b"]) {
      const decision = decidePath(policy, "read", path)
      expect(decision.allowed).toBe(false)
      expect(decision.layer).toBeDefined(); expect(decision.rule).toBeDefined()
    }
  })

  test("hash is stable across equivalent ordering", () => {
    const a = compilePolicy(layers({ installation: { ...allow("repo.read", ["b/**", "a/**"]), capabilities: ["repo.read"] } }))
    const b = compilePolicy(layers({ installation: { ...allow("repo.read", ["a/**", "b/**"]), capabilities: ["repo.read"] } }))
    expect(effectivePolicyHash(a)).toBe(effectivePolicyHash(b))
  })
})
