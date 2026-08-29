import { createHash } from "node:crypto"
import { z } from "zod"
import type { WorkflowDefinition } from "./types"

export type ValidationIssue = Readonly<{ code: string; path: readonly (string | number)[]; message: string }>
export type ParseResult = Readonly<{ value?: WorkflowDefinition; issues: readonly ValidationIssue[] }>

const capability = z.enum([
  "repo.read", "repo.search", "git.status", "git.diff", "git.log", "git.stage", "git.commit",
  "web.search", "web.fetch", "test.run", "typecheck.run", "lint.run", "build.run", "workspace.patch",
  "workspace.create", "workspace.delete", "agents.spawn", "agents.message", "agents.wait",
])
const workspaceMode = z.enum(["read-only", "current", "worktree", "existing"])
const outputType = z.enum(["json", "markdown", "text", "number", "boolean"])
const permissions = z.object({
  capabilities: z.array(capability).default([]), deny: z.array(capability).default([]),
  readPaths: z.array(z.string()).default([]), writePaths: z.array(z.string()).default([]),
}).strict()
const command = z.object({ executable: z.string().min(1), argv: z.array(z.string()), cwd: z.string().default("."), env: z.array(z.string()).default([]) }).strict()
const commands = z.object({ default: z.literal("deny").default("deny"), allow: z.array(command).default([]), deny: z.array(command).default([]) }).strict()
const step = z.object({
  id: z.string().min(1), description: z.string().optional(), prompt: z.string().min(1),
  dependsOn: z.array(z.string()).default([]), model: z.object({ mode: z.enum(["configured", "inherit", "alias"]), alias: z.string().optional() }).strict(),
  workspace: z.object({ mode: workspaceMode }).strict(), permissions, commands: z.array(command).default([]),
  inputs: z.array(z.object({ step: z.string().min(1), output: z.string().min(1), as: z.string().min(1) }).strict()).default([]),
  outputs: z.array(z.object({ name: z.string().min(1), type: outputType, required: z.boolean() }).strict()).default([]),
  limits: z.object({ timeoutSeconds: z.number().int().positive(), maxOutputBytes: z.number().int().positive(), maxChildAgents: z.number().int().nonnegative() }).strict(),
}).strict()
const workflow = z.object({
  schemaVersion: z.literal(1), name: z.string().min(1), description: z.string().optional(),
  failurePolicy: z.enum(["fail-fast", "continue-independent"]).default("fail-fast"), maxConcurrency: z.number().int().positive().default(1),
  permissions: permissions.default({ capabilities: [], deny: [], readPaths: [], writePaths: [] }),
  workspace: z.object({ allowedModes: z.array(workspaceMode).default(["read-only"]), defaultMode: workspaceMode.default("read-only") }).strict().default({ allowedModes: ["read-only"], defaultMode: "read-only" }),
  commands: commands.default({ default: "deny", allow: [], deny: [] }), steps: z.array(step).default([]),
}).strict()

function scope(value: string): string {
  const replaced = value.replaceAll("\\", "/")
  if (replaced.startsWith("/") || /^[A-Za-z]:\//.test(replaced)) throw new Error("malformed path")
  const parts: string[] = []
  for (const part of replaced.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") { if (parts.length) parts.pop(); else throw new Error("malformed path"); continue }
    parts.push(part)
  }
  return parts.join("/") || "."
}
function sort(values: readonly string[]): string[] { return [...values].sort() }
function compareCodePoint(a: string, b: string): number {
  const aa = Array.from(a), bb = Array.from(b)
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    const diff = aa[i].codePointAt(0)! - bb[i].codePointAt(0)!
    if (diff) return diff
  }
  return aa.length - bb.length
}
function normalize(input: any): WorkflowDefinition {
  const p = (v: any) => ({ ...v, capabilities: sort(v.capabilities), deny: sort(v.deny), readPaths: sort(v.readPaths.map(scope)), writePaths: sort(v.writePaths.map(scope)) })
  const c = (v: any) => ({ ...v, cwd: scope(v.cwd), env: sort(v.env) })
  const normalized: any = {
    ...input, permissions: p(input.permissions), workspace: { ...input.workspace, allowedModes: sort(input.workspace.allowedModes) },
    commands: { ...input.commands, allow: input.commands.allow.map(c), deny: input.commands.deny.map(c) },
    steps: input.steps.map((s: any) => ({ ...s, dependsOn: sort(s.dependsOn), permissions: p(s.permissions), commands: s.commands.map(c), outputs: [...s.outputs].sort((a, b) => compareCodePoint(a.name, b.name)), inputs: [...s.inputs].sort((a, b) => compareCodePoint(`${a.step}:${a.output}:${a.as}`, `${b.step}:${b.output}:${b.as}`)) })),
  }
  return { ...normalized, hash: workflowHash(normalized) }
}
function issueCode(issue: z.core.$ZodIssue): string {
  if (issue.code === "invalid_type" && (issue as any).expected === "object" && issue.path.includes("commands")) return "command.string_not_allowed"
  if (issue.code === "unrecognized_keys") return "workflow.unknown"
  return "workflow.invalid"
}
export function parseWorkflow(input: unknown): ParseResult {
  const result = workflow.safeParse(input)
  if (!result.success) return { issues: result.error.issues.map((i) => ({ code: issueCode(i), path: i.path.filter((p): p is string | number => typeof p !== "symbol"), message: i.code === "invalid_type" && /received undefined$/.test(i.message) ? "Required" : i.message })) }
  const paths: Array<{ value: string; path: (string | number)[] }> = []
  const collect = (v: any, path: (string | number)[]) => { for (const key of ["readPaths", "writePaths"]) for (let i = 0; i < (v?.[key] ?? []).length; i++) paths.push({ value: v[key][i], path: [...path, key, i] }) }
  collect(result.data.permissions, ["permissions"])
  for (const key of ["allow", "deny"] as const) for (let j = 0; j < result.data.commands[key].length; j++) paths.push({ value: result.data.commands[key][j].cwd, path: ["commands", key, j, "cwd"] })
  for (let i = 0; i < result.data.steps.length; i++) { collect(result.data.steps[i].permissions, ["steps", i, "permissions"]); for (const key of ["allow", "deny"]) for (let j = 0; j < result.data.steps[i].commands.length; j++) paths.push({ value: result.data.steps[i].commands[j].cwd, path: ["steps", i, "commands", j, "cwd"] }) }
  for (const item of paths) { try { scope(item.value) } catch { return { issues: [{ code: "workflow.invalid", path: item.path, message: "Malformed path" }] } } }
  const seen = new Set<string>()
  for (let i = 0; i < result.data.steps.length; i++) {
    if (seen.has(result.data.steps[i].id)) return { issues: [{ code: "workflow.invalid", path: ["steps", i, "id"], message: "Duplicate step id" }] }
    seen.add(result.data.steps[i].id)
  }
  try { return { value: normalize(result.data), issues: [] } }
  catch { return { issues: [{ code: "workflow.invalid", path: [], message: "Malformed path" }] } }
}
export function normalizeWorkflow(input: WorkflowDefinition): WorkflowDefinition { const { hash: _hash, ...withoutHash } = input; return normalize(withoutHash as Omit<WorkflowDefinition, "hash">) }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`
  return JSON.stringify(value)
}
export function workflowHash(input: WorkflowDefinition | Omit<WorkflowDefinition, "hash">): string {
  const { hash: _hash, ...withoutHash } = input as WorkflowDefinition
  return createHash("sha256").update(canonical(withoutHash)).digest("hex")
}
