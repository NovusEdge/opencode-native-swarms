import { describe, expect, test } from "bun:test"
import { bindWorkflowCommand, compileCommandPolicy, evaluateCommand, runApprovedCommand } from "./commands"
import type { CommandSpec, ProcessAdapter } from "./types"

const command = (argv: string[] = ["check"]): CommandSpec => ({ executable: "bun", argv, cwd: ".", env: ["PATH"] })
const sets = (allow: CommandSpec[], deny: CommandSpec[] = []) => ({ default: "deny" as const, allow, deny })
const policy = (c = command()) => compileCommandPolicy({ installation: sets([c]), workflow: sets([c]), step: sets([c]), maxTimeoutSeconds: 2, maxOutputBytes: 8 })
const env = { get: (name: string) => name === "PATH" ? "/bin" : undefined, homeDirectory: () => "/home/test" }
const filesystem = { realpath: async (path: string) => path }
const runOptions = (process: ProcessAdapter, p = policy(), fs = filesystem) => ({ policy: p, process, environment: env, filesystem: fs, repositoryRoot: "/repo", now: () => 0 })

describe("structured command policy", () => {
  test("allows exact argv and passes direct argv to the process adapter", async () => {
    const calls: unknown[] = []
    const process: ProcessAdapter = { run: async (input) => { calls.push(input); return { stdout: "ok", stderr: "", exitCode: 0 } } }
    const evidence = await runApprovedCommand(runOptions(process), command())
    expect(evidence.allowed).toBe(true)
    expect(calls[0]).toMatchObject({ argv: ["bun", "check"], cwd: "/repo", timeoutMs: 2000, maxStdoutBytes: 8 })
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
    const evidence = await runApprovedCommand(runOptions(process), command())
    expect(evidence.stdout).toBe("12345678")
    expect(evidence.outputLimited).toBe(true)
  })

  test("only the run-scoped workflow_command binding reaches the adapter", async () => {
    let calls = 0
    const process: ProcessAdapter = { run: async () => { calls++; return { stdout: "", stderr: "", exitCode: 0 } } }
    const tool = bindWorkflowCommand({ sessionID: "s", runID: "r", stepID: "t", policy: policy(), process, environment: env, filesystem, repositoryRoot: "/repo", now: () => 0 })
    await tool({ sessionID: "s", runID: "r", stepID: "t", command: command() })
    expect(calls).toBe(1)
    expect(tool({ sessionID: "other", runID: "r", stepID: "t", command: command() })).rejects.toThrow("scope mismatch")
  })

  test("contains cwd and sources environment from the provider", async () => {
    const calls: any[] = []
    const process: ProcessAdapter = { run: async (input) => { calls.push(input); return { stdout: "", stderr: "", exitCode: 0 } } }
    const evidence = await runApprovedCommand(runOptions(process), command())
    expect(calls[0].cwd).toBe("/repo")
    expect(calls[0].env).toEqual({ PATH: "/bin" })
    expect(evidence.containedCwd).toBe("/repo")
    expect(evidence.startedAt).toBe("1970-01-01T00:00:00.000Z")
    expect(evaluateCommand(policy(), { ...command(), cwd: "../outside" }).decision.allowed).toBe(false)
  })

  test("keeps deny floor and compiled snapshot immutable", () => {
    const push = { ...command(), executable: "git", argv: ["push"] }
    const p = compileCommandPolicy({ installation: sets([push]), workflow: sets([push]), step: sets([push]), maxTimeoutSeconds: 2, maxOutputBytes: 8 })
    expect(evaluateCommand(p, push).decision.allowed).toBe(false)
    const originalHash = p.hash
    expect(() => (p.installation.allow as CommandSpec[]).push(command())).toThrow()
    expect(p.hash).toBe(originalHash)
    expect(evaluateCommand(p, push).decision.allowed).toBe(false)
    expect(() => ((p as any).layers = [])).toThrow()
    expect(() => ((p as any).installation = sets([command()]))).toThrow()
    expect(() => ((p.layers[0] as any).set = sets([command()]))).toThrow()
    expect(() => ((p.layers[0] as any).name = "changed")).toThrow()
  })

  test("blocks merges, release tooling, and external writes", () => {
    const cases: Array<[string, string[]]> = [["git", ["merge"]], ["gh", ["pr", "merge"]], ["docker", ["push"]], ["aws", ["deploy"]], ["twine", ["upload"]]]
    for (const [executable, argv] of cases) {
      const c = { ...command(argv), executable }
      const p = compileCommandPolicy({ installation: sets([c]), workflow: sets([c]), step: sets([c]), maxTimeoutSeconds: 2, maxOutputBytes: 8 })
      expect(evaluateCommand(p, c).decision.allowed).toBe(false)
    }
  })

  test("deny floor recognizes option-prefixed operations", () => {
    for (const [executable, argv] of [["git", ["-C", "repo", "push"]], ["git", ["--git-dir=x", "merge"]], ["gh", ["--repo", "org/repo", "pr", "merge"]], ["npm", ["--registry", "x", "publish"]] ] as Array<[string, string[]]>) {
      const c = { ...command(argv), executable }
      const p = compileCommandPolicy({ installation: sets([c]), workflow: sets([c]), step: sets([c]), maxTimeoutSeconds: 2, maxOutputBytes: 8 })
      expect(evaluateCommand(p, c).decision.allowed).toBe(false)
    }
  })

  test("rejects symlink-resolved cwd outside repository", async () => {
    const process: ProcessAdapter = { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }
    const fs = { realpath: async (path: string) => path === "/repo/tools" ? "/tmp/outside" : path }
    const c = { ...command(), cwd: "tools" }
    const p = policy(c)
    const evidence = await runApprovedCommand(runOptions(process, p, fs), c)
    expect(evidence.allowed).toBe(false)
    expect(evidence.decision?.rule).toBe("repository-contained")
  })

  test("keeps sanitized evidence within byte cap", async () => {
    const process: ProcessAdapter = { run: async () => ({ stdout: "\0", stderr: "\0", exitCode: 0 }) }
    const p = compileCommandPolicy({ installation: sets([command()]), workflow: sets([command()]), step: sets([command()]), maxTimeoutSeconds: 2, maxOutputBytes: 1 })
    const evidence = await runApprovedCommand(runOptions(process, p), command())
    expect(new TextEncoder().encode(evidence.stdout ?? "").byteLength).toBeLessThanOrEqual(1)
    expect(new TextEncoder().encode(evidence.stderr ?? "").byteLength).toBeLessThanOrEqual(1)
  })

  test("requires and consumes a hash-bound approval token", async () => {
    let consumed = false
    const process: ProcessAdapter = { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }
    const tool = bindWorkflowCommand({ sessionID: "s", runID: "r", stepID: "t", policy: policy(), process, environment: env, filesystem, repositoryRoot: "/repo", now: () => 0, approval: { required: true, consume: (token, hash, commandHash) => { consumed = token === "ok" && hash.length === 64 && commandHash.length === 64; return consumed } } })
    expect(tool({ sessionID: "s", runID: "r", stepID: "t", command: command() })).rejects.toThrow("approval token")
    await tool({ sessionID: "s", runID: "r", stepID: "t", command: command(), approvalToken: "ok" })
    expect(consumed).toBe(true)
  })

  test("rejects nul, percent, tilde, and unresolved expansion tokens", () => {
    for (const token of ["%PATH%", "~", "${MISSING}", "a\0b"]) expect(evaluateCommand(policy(), { ...command([token]) }).decision.allowed).toBe(false)
  })
})
