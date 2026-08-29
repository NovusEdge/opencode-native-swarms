import { describe, expect, test } from "bun:test"
import {
  CAPABILITIES,
  OUTPUT_TYPES,
  STEP_STATES,
  WORKFLOW_STATES,
  type Capability,
  type OutputType,
  type StepState,
  type WorkflowState,
  type WorkflowDefinition,
} from "./types"

type WorkflowHashIsRequired = WorkflowDefinition extends { readonly hash: string } ? true : false
const workflowHashIsRequired: WorkflowHashIsRequired = true

describe("workflow contracts", () => {
  test("exposes exactly the v0.2 capability vocabulary", () => {
    expect([...CAPABILITIES]).toEqual([
      "repo.read", "repo.search", "git.status", "git.diff", "git.log",
      "git.stage", "git.commit", "web.search", "web.fetch", "test.run",
      "typecheck.run", "lint.run", "build.run", "workspace.patch",
      "workspace.create", "workspace.delete", "agents.spawn", "agents.message",
      "agents.wait",
    ])
    const capability: Capability = "repo.read"
    expect(capability).toBe("repo.read")
  })

  test("exposes lifecycle states without paused", () => {
    expect([...WORKFLOW_STATES]).toEqual([
      "draft", "awaiting-approval", "running", "succeeded", "failed", "cancelled", "stale",
    ])
    expect([...STEP_STATES]).toEqual(["queued", "ready", "running", "succeeded", "failed", "cancelled", "skipped"])
    expect([...OUTPUT_TYPES]).toEqual(["json", "markdown", "text", "number", "boolean"])
    const workflowState: WorkflowState = "draft"
    const stepState: StepState = "queued"
    const outputType: OutputType = "json"
    expect([workflowState, stepState, outputType]).toEqual(["draft", "queued", "json"])
    expect(WORKFLOW_STATES).not.toContain("paused")
    expect(STEP_STATES).not.toContain("paused")
    expect(workflowHashIsRequired).toBe(true)
  })
})
