import { describe, expect, test } from "bun:test"
import { parseWorkflow, workflowHash } from "./schema"

describe("workflow schema", () => {
  const validStep = { id: "review", prompt: "Review", model: { mode: "configured" }, workspace: { mode: "read-only" }, permissions: {}, limits: { timeoutSeconds: 10, maxOutputBytes: 100, maxChildAgents: 0 } }
  test("accepts the normative review-and-verify definition shape", () => {
    const result = parseWorkflow({ schemaVersion: 1, name: "review-and-verify", description: "Review and verify", failurePolicy: "continue-independent", maxConcurrency: 3, permissions: { capabilities: ["repo.read", "repo.search", "git.diff", "test.run", "typecheck.run"], deny: [], readPaths: ["**"], writePaths: [] }, workspace: { allowedModes: ["read-only"], defaultMode: "read-only" }, commands: { default: "deny", allow: [{ executable: "bun", argv: ["run", "check"] }], deny: [] }, steps: [{ ...validStep, id: "review", description: "Review change", outputs: [{ name: "findings", type: "json", required: true }] }, { ...validStep, id: "synthesize", prompt: "Synthesize", dependsOn: ["review"], inputs: [{ step: "review", output: "findings", as: "findings" }], outputs: [{ name: "summary", type: "markdown", required: true }] }] })
    expect(result.issues).toEqual([])
    expect(result.value?.name).toBe("review-and-verify")
  })
  test("requires a name with stable issues", () => {
    expect(parseWorkflow({ schemaVersion: 1 }).issues).toEqual([{ code: "workflow.invalid", path: ["name"], message: "Required" }])
  })
  test("normalizes command defaults and set-like fields", () => {
    const result = parseWorkflow({ schemaVersion: 1, name: "x", commands: { allow: [{ executable: "bun", argv: ["run", "check"] }] }, steps: [] })
    expect(result.issues).toEqual([])
    expect(result.value?.commands.allow[0]).toMatchObject({ cwd: ".", env: [] })
  })
  test("rejects unknown fields and shell commands", () => {
    expect(parseWorkflow({ schemaVersion: 1, name: "x", extra: true }).issues[0].code).toBe("workflow.unknown")
    expect(parseWorkflow({ schemaVersion: 1, name: "x", commands: { allow: ["bun test"] } }).issues[0].code).toBe("command.string_not_allowed")
    expect(parseWorkflow({ schemaVersion: 1, name: "x", steps: [{ ...validStep, permissions: { nope: [] } }] }).issues[0]).toEqual({ code: "workflow.unknown", path: ["steps", 0, "permissions"], message: "Unrecognized key: \"nope\"" })
  })
  test("covers version, enums, duplicate IDs, malformed paths, and prompts", () => {
    expect(parseWorkflow({ schemaVersion: 2, name: "x" }).issues[0]).toMatchObject({ code: "workflow.invalid", path: ["schemaVersion"] })
    expect(parseWorkflow({ schemaVersion: 1, name: "x", workspace: { allowedModes: ["bogus"], defaultMode: "read-only" } }).issues[0]).toMatchObject({ code: "workflow.invalid", path: ["workspace", "allowedModes", 0] })
    expect(parseWorkflow({ schemaVersion: 1, name: "x", steps: [validStep, { ...validStep, prompt: "Again" }] }).issues[0]).toEqual({ code: "workflow.invalid", path: ["steps", 1, "id"], message: "Duplicate step id" })
    expect(parseWorkflow({ schemaVersion: 1, name: "x", permissions: { readPaths: ["../outside"] } }).issues[0]).toEqual({ code: "workflow.invalid", path: ["permissions", "readPaths", 0], message: "Malformed path" })
    expect(parseWorkflow({ schemaVersion: 1, name: "x", steps: [((({ ...validStep, prompt: undefined }) as unknown))] }).issues[0]).toEqual({ code: "workflow.invalid", path: ["steps", 0, "prompt"], message: "Required" })
  })
  test("applies command defaults to workflow and steps", () => {
    const result = parseWorkflow({ schemaVersion: 1, name: "x", commands: { allow: [{ executable: "bun", argv: [] }] }, steps: [{ ...validStep, commands: [{ executable: "git", argv: [] }] }] })
    expect(result.value?.commands.allow[0]).toMatchObject({ cwd: ".", env: [] })
    expect(result.value?.steps[0].commands[0]).toMatchObject({ cwd: ".", env: [] })
  })
  test("hashes canonical JSON", () => {
    const a = parseWorkflow({ schemaVersion: 1, name: "x", permissions: { capabilities: ["repo.read", "git.status"] } })
    const b = parseWorkflow({ permissions: { capabilities: ["git.status", "repo.read"] }, name: "x", schemaVersion: 1 })
    expect(a.value).toEqual(b.value)
    expect(a.value && workflowHash(a.value)).toBe(b.value && workflowHash(b.value))
  })
})
