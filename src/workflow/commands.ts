import { createHash } from "node:crypto"
import type { CommandEvidence, CommandSpec, EnvironmentProvider, ProcessAdapter } from "./types"

export type CommandSet = Readonly<{ default: "deny"; allow: readonly CommandSpec[]; deny: readonly CommandSpec[] }>
export type CommandPolicyInput = Readonly<{
  installation: CommandSet | Readonly<{ commands?: CommandSet }>
  launch?: CommandSet
  workflow: CommandSet
  step?: CommandSet
  maxTimeoutSeconds: number
  maxOutputBytes: number
}>
export type CompiledCommandPolicy = Readonly<{
  hash: string
  installation: CommandSet
  layers: readonly { name: string; set: CommandSet }[]
  maxTimeoutSeconds: number
  maxOutputBytes: number
}>
export type CommandRequest = CommandSpec
export type CommandRunOptions = Readonly<{
  policy: CompiledCommandPolicy
  process: ProcessAdapter
  environment: EnvironmentProvider
  repositoryRoot: string
  now: () => number
  signal?: AbortSignal
  sessionID?: string
  runID?: string
  stepID?: string
}>

const FLOOR_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "fish", "csh", "ksh", "pwsh", "powershell", "sudo", "su", "ssh", "scp", "sftp", "nc", "netcat", "curl", "wget"])
const SHELL_TOKEN = /[|<>;&`$(){}!\n\r\0%~]|\*|\?|\[.*\]/
const INLINE_ENV = /^[A-Za-z_][A-Za-z0-9_]*=/
const basename = (value: string) => value.replaceAll("\\", "/").split("/").pop()!.toLowerCase()
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(value)
const same = (a: CommandSpec, b: CommandSpec) => a.executable === b.executable && a.cwd === b.cwd && a.argv.length === b.argv.length && a.argv.every((v, i) => v === b.argv[i]) && a.env.length === b.env.length && a.env.every((v, i) => v === b.env[i])
const commandHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")
function cloneSet(set: CommandSet): CommandSet {
  const clone = (command: CommandSpec): CommandSpec => Object.freeze({ executable: command.executable, argv: Object.freeze([...command.argv]), cwd: command.cwd, env: Object.freeze([...command.env]) })
  return Object.freeze({ default: "deny", allow: Object.freeze(set.allow.map(clone)), deny: Object.freeze(set.deny.map(clone)) })
}
function commandSet(value: CommandSet | Readonly<{ commands?: CommandSet }>): CommandSet {
  return "commands" in value ? value.commands ?? { default: "deny", allow: [], deny: [] } : value as CommandSet
}

export function compileCommandPolicy(input: CommandPolicyInput): CompiledCommandPolicy {
  const installation = cloneSet(commandSet(input.installation))
  const layers = [{ name: "installation", set: installation }, ...(input.launch ? [{ name: "launch", set: cloneSet(input.launch) }] : []), { name: "workflow", set: cloneSet(input.workflow) }, ...(input.step ? [{ name: "step", set: cloneSet(input.step) }] : [])]
  const body = { installation, layers, maxTimeoutSeconds: input.maxTimeoutSeconds, maxOutputBytes: input.maxOutputBytes }
  return { ...body, hash: commandHash(body) }
}

function malformed(command: CommandSpec): string | undefined {
  if (!command.executable || command.executable.includes("\0") || SHELL_TOKEN.test(command.executable)) return "Malformed executable"
  if (command.cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(command.cwd) || command.cwd.split("/").includes("..")) return "Working directory must be repository-root-relative"
  for (const token of [command.executable, command.cwd, ...command.argv, ...command.env]) {
    if (SHELL_TOKEN.test(token) || INLINE_ENV.test(token)) return "Shell composition is not allowed"
  }
  return undefined
}

function floorDenied(command: CommandSpec): string | undefined {
  const exe = basename(command.executable)
  const args = command.argv.map((arg) => arg.toLowerCase())
  if (FLOOR_EXECUTABLES.has(exe)) return "Executable is blocked by the installation deny floor"
  if (exe === "git" && (args[0] === "push" || args[0] === "tag" && args.includes("--force"))) return "Git remote mutation is blocked by the installation deny floor"
  if (["npm", "pnpm", "yarn", "bun", "cargo", "gem", "dotnet"].includes(exe) && args.includes("publish")) return "Package publication is blocked by the installation deny floor"
  if (exe === "gh" && args[0] === "release") return "Release operations are blocked by the installation deny floor"
  return undefined
}

export function evaluateCommand(policy: CompiledCommandPolicy, command: CommandRequest): Readonly<{ decision: ReturnType<typeof deny> | { allowed: true; policyHash: string; rule?: string }; command: CommandSpec }> {
  const bad = malformed(command)
  if (bad) return { command, decision: deny("command", "shell-composition", bad) }
  const floor = floorDenied(command)
  if (floor) return { command, decision: deny("installation", "deny-floor", floor) }
  for (const layer of policy.layers) {
    const denied = layer.set.deny.find((rule) => same(rule, command))
    if (denied) return { command, decision: deny(layer.name, "deny", "Command denied") }
  }
  // The installation allowlist is an immutable floor: unknown executables never run.
  if (!policy.installation.allow.some((rule) => same(rule, command))) return { command, decision: deny("installation", "allow", "Executable or exact argv is not installed") }
  for (const layer of policy.layers.slice(1)) {
    if (!layer.set.allow.some((rule) => same(rule, command))) return { command, decision: deny(layer.name, "allow", "Command is not allowed in this scope") }
  }
  return { command, decision: { allowed: true, policyHash: policy.hash } }
}
function deny(layer: string, rule: string, reason: string) { return { allowed: false as const, layer, rule, reason } }

function bounded(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maxBytes) return { value: value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "�"), truncated: false }
  return { value: new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "�"), truncated: true }
}

export async function runApprovedCommand(options: CommandRunOptions, command: CommandRequest): Promise<CommandEvidence> {
  const evaluated = evaluateCommand(options.policy, command)
  const startedAt = new Date(options.now()).toISOString()
  if (!evaluated.decision.allowed) return { command, allowed: false, decision: evaluated.decision, policyHash: options.policy.hash, startedAt, finishedAt: new Date(options.now()).toISOString() }
  if (command.cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(command.cwd) || command.cwd.split("/").includes("..")) {
    const decision = deny("path", "repository-root-relative", "Working directory escapes repository root")
    return { command, allowed: false, decision, policyHash: options.policy.hash, startedAt, finishedAt: new Date(options.now()).toISOString() }
  }
  const containedCwd = command.cwd === "." ? options.repositoryRoot : `${options.repositoryRoot.replace(/[\\/]$/, "")}/${command.cwd}`
  const env: Record<string, string> = {}
  for (const name of command.env) {
    const value = options.environment.get(name)
    if (value !== undefined) env[name] = value
  }
  const result = await options.process.run({ argv: [command.executable, ...command.argv], cwd: containedCwd, env, timeoutMs: options.policy.maxTimeoutSeconds * 1000, maxStdoutBytes: options.policy.maxOutputBytes, maxStderrBytes: options.policy.maxOutputBytes, signal: options.signal })
  const stdout = bounded(result.stdout, options.policy.maxOutputBytes)
  const stderr = bounded(result.stderr, options.policy.maxOutputBytes)
  return { command, allowed: true, decision: evaluated.decision, containedCwd, startedAt, finishedAt: new Date(options.now()).toISOString(), exitCode: result.exitCode, stdout: stdout.value, stderr: stderr.value, timedOut: result.timedOut, outputLimited: result.outputLimited || stdout.truncated || stderr.truncated, policyHash: options.policy.hash }
}

export function bindWorkflowCommand(scope: Readonly<{ sessionID: string; runID: string; stepID: string; policy: CompiledCommandPolicy; process: ProcessAdapter; environment: EnvironmentProvider; repositoryRoot: string; now: () => number; approval?: Readonly<{ required: boolean; token?: string; consume: (token: string, policyHash: string, commandHash: string) => boolean }> }>) {
  return async (input: Readonly<{ sessionID: string; runID: string; stepID: string; command: CommandSpec; approvalToken?: string; signal?: AbortSignal }>) => {
    if (input.sessionID !== scope.sessionID || input.runID !== scope.runID || input.stepID !== scope.stepID) throw new Error("workflow_command scope mismatch")
    const required = scope.approval?.required ?? false
    const hash = commandHash(input.command)
    if (required && (!input.approvalToken || !scope.approval?.consume(input.approvalToken, scope.policy.hash, hash))) throw new Error("invalid or already consumed approval token")
    return runApprovedCommand({ policy: scope.policy, process: scope.process, environment: scope.environment, repositoryRoot: scope.repositoryRoot, now: scope.now, signal: input.signal, sessionID: scope.sessionID, runID: scope.runID, stepID: scope.stepID }, input.command)
  }
}
export const createWorkflowCommandTool = bindWorkflowCommand
