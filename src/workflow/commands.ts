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
  environment?: EnvironmentProvider
  runtimeEnv?: Readonly<Record<string, string | undefined>>
  signal?: AbortSignal
  sessionID?: string
  runID?: string
  stepID?: string
}>

const FLOOR_EXECUTABLES = new Set(["sh", "bash", "zsh", "dash", "fish", "csh", "ksh", "pwsh", "powershell", "sudo", "su", "ssh", "scp", "sftp", "nc", "netcat", "curl", "wget"])
const SHELL_TOKEN = /[|<>;&`$(){}!\n\r]|\*|\?|\[.*\]/
const INLINE_ENV = /^[A-Za-z_][A-Za-z0-9_]*=/
const basename = (value: string) => value.replaceAll("\\", "/").split("/").pop()!.toLowerCase()
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(value)
const same = (a: CommandSpec, b: CommandSpec) => a.executable === b.executable && a.cwd === b.cwd && a.argv.length === b.argv.length && a.argv.every((v, i) => v === b.argv[i]) && a.env.length === b.env.length && a.env.every((v, i) => v === b.env[i])
const commandHash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")
function commandSet(value: CommandSet | Readonly<{ commands?: CommandSet }>): CommandSet {
  return "commands" in value ? value.commands ?? { default: "deny", allow: [], deny: [] } : value as CommandSet
}

export function compileCommandPolicy(input: CommandPolicyInput): CompiledCommandPolicy {
  const installation = commandSet(input.installation)
  const layers = [{ name: "installation", set: installation }, ...(input.launch ? [{ name: "launch", set: input.launch }] : []), { name: "workflow", set: input.workflow }, ...(input.step ? [{ name: "step", set: input.step }] : [])]
  const body = { installation, layers, maxTimeoutSeconds: input.maxTimeoutSeconds, maxOutputBytes: input.maxOutputBytes }
  return { ...body, hash: commandHash(body) }
}

function malformed(command: CommandSpec): string | undefined {
  if (!command.executable || command.executable.includes("\0") || SHELL_TOKEN.test(command.executable)) return "Malformed executable"
  for (const token of [command.executable, command.cwd, ...command.argv, ...command.env]) {
    if (SHELL_TOKEN.test(token) || INLINE_ENV.test(token)) return "Shell composition is not allowed"
  }
  return undefined
}

export function evaluateCommand(policy: CompiledCommandPolicy, command: CommandRequest): Readonly<{ decision: ReturnType<typeof deny> | { allowed: true; policyHash: string; rule?: string }; command: CommandSpec }> {
  const bad = malformed(command)
  if (bad) return { command, decision: deny("command", "shell-composition", bad) }
  if (FLOOR_EXECUTABLES.has(basename(command.executable))) return { command, decision: deny("installation", "deny-floor", "Executable is blocked by the installation deny floor") }
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
  if (!evaluated.decision.allowed) return { command, allowed: false, policyHash: options.policy.hash }
  const env: Record<string, string> = {}
  for (const name of command.env) {
    const value = options.runtimeEnv?.[name] ?? options.environment?.get(name)
    if (value !== undefined) env[name] = value
  }
  const result = await options.process.run({ argv: [command.executable, ...command.argv], cwd: command.cwd, env, timeoutMs: Math.min(options.policy.maxTimeoutSeconds * 1000, options.policy.maxTimeoutSeconds * 1000), maxStdoutBytes: options.policy.maxOutputBytes, maxStderrBytes: options.policy.maxOutputBytes, signal: options.signal })
  const stdout = bounded(result.stdout, options.policy.maxOutputBytes)
  const stderr = bounded(result.stderr, options.policy.maxOutputBytes)
  return { command, allowed: true, exitCode: result.exitCode, stdout: stdout.value, stderr: stderr.value, timedOut: result.timedOut, outputLimited: result.outputLimited || stdout.truncated || stderr.truncated, policyHash: options.policy.hash }
}

export function bindWorkflowCommand(scope: Readonly<{ sessionID: string; runID: string; stepID: string; policy: CompiledCommandPolicy; process: ProcessAdapter; environment?: EnvironmentProvider }>) {
  return async (input: Readonly<{ sessionID: string; runID: string; stepID: string; command: CommandSpec; runtimeEnv?: Readonly<Record<string, string | undefined>>; signal?: AbortSignal }>) => {
    if (input.sessionID !== scope.sessionID || input.runID !== scope.runID || input.stepID !== scope.stepID) throw new Error("workflow_command scope mismatch")
    return runApprovedCommand({ policy: scope.policy, process: scope.process, environment: scope.environment, runtimeEnv: input.runtimeEnv, signal: input.signal, sessionID: scope.sessionID, runID: scope.runID, stepID: scope.stepID }, input.command)
  }
}
export const createWorkflowCommandTool = bindWorkflowCommand
