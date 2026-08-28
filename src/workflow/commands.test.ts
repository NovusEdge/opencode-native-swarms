import { describe, expect, test } from "bun:test"
import { bindWorkflowCommand, compileCommandPolicy, evaluateCommand, runApprovedCommand } from "./commands"
import type { CommandSpec, ProcessAdapter } from "./types"

const command = (argv: string[] = ["check"]): CommandSpec => ({ executable: "bun", argv, cwd: ".", env: ["PATH"] })
const sets = (allow: CommandSpec[], deny: CommandSpec[] = []) => ({ default: "deny" as const, allow, deny })
const policy = (c = command()) => compileCommandPolicy({ installation: sets([c]), workflow: sets([c]), step: sets([c]), maxTimeoutSeconds: 2, maxOutputBytes: 8 })

describe("structured command policy", () => {
  test("allows exact argv and passes direct argv to the process adapter", async () => {
    const calls: unknown[] = []
    const process: ProcessAdapter = { run: async (input) => { calls.push(input); return { stdout: "ok", stderr: "", exitCode: 0 } } }
    const evidence = await runApprovedCommand({ policy: policy(), process }, command())
    expect(evidence.allowed).toBe(true)
    expect(calls[0]).toMatchObject({ argv: ["bun", "check"], cwd: ".", timeoutMs: 2000, maxStdoutBytes: 8 })
  })

  test("applies deny precedence and denies unknown executables", () => {
    const c = command()
    const denied = compileCommandPolicy({ installation: sets([c]), workflow: sets([c], [c]), maxTimeoutSeconds: 2, maxOutputBytes: 8 })
    expect(evaluateCommand(denied, c).decision.allowed).toBe(false)
    const unknown = { ...c, executable: "unknown" }
    expect(evaluateCommand(policy(), unknown).decision.allowed).toBe(false)
  })

  test("rejects shell composition and floor executables", () => {
    for (const token of ["a|b", "a > b", "$(id)", "a && b", "a &", "fn()", "FOO=bar", "$UNRESOLVED"]) {
      expect(evaluateCommand(policy(), { ...command([token]) }).decision.allowed).toBe(false)
    }
    expect(evaluateCommand(policy(), { ...command(), executable: "sh" }).decision.allowed).toBe(false)
  })

  test("sanitizes and bounds evidence", async () => {
    const process: ProcessAdapter = { run: async () => ({ stdout: "123456789\u0000", stderr: "err", exitCode: 3 }) }
    const evidence = await runApprovedCommand({ policy: policy(), process }, command())
    expect(evidence.stdout).toBe("12345678")
    expect(evidence.outputLimited).toBe(true)
  })

  test("only the run-scoped workflow_command binding reaches the adapter", async () => {
    let calls = 0
    const process: ProcessAdapter = { run: async () => { calls++; return { stdout: "", stderr: "", exitCode: 0 } } }
    const tool = bindWorkflowCommand({ sessionID: "s", runID: "r", stepID: "t", policy: policy(), process })
    await tool({ sessionID: "s", runID: "r", stepID: "t", command: command() })
    expect(calls).toBe(1)
    expect(tool({ sessionID: "other", runID: "r", stepID: "t", command: command() })).rejects.toThrow("scope mismatch")
  })
})
