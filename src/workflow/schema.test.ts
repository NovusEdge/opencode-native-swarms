import { describe, expect, test } from "bun:test"
import { parseWorkflow, workflowHash } from "./schema"

describe("workflow schema", () => {
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
  })
  test("hashes canonical JSON", () => {
    const a = parseWorkflow({ schemaVersion: 1, name: "x", permissions: { capabilities: ["repo.read", "git.status"] } })
    const b = parseWorkflow({ permissions: { capabilities: ["git.status", "repo.read"] }, name: "x", schemaVersion: 1 })
    expect(a.value).toEqual(b.value)
    expect(a.value && workflowHash(a.value)).toBe(b.value && workflowHash(b.value))
  })
})
