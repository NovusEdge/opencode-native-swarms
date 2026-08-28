import { tool } from "@opencode-ai/plugin"
import { realpath } from "node:fs/promises"
import { runBounded } from "./process"

const allowedAgents = new Set(["swarm-reviewer", "swarm-tester"])
const maximumOutputLength = 200_000
const protectedPathspecs = [
  ":(glob,exclude).env",
  ":(glob,exclude).env.*",
  ":(glob,exclude)*.env",
  ":(glob,exclude)*.env.*",
  ":(glob,exclude)secrets/**",
  ":(glob,exclude)**/.env",
  ":(glob,exclude)**/.env.*",
  ":(glob,exclude)**/*.env",
  ":(glob,exclude)**/*.env.*",
  ":(glob,exclude)**/secrets/**",
] as const

const operationSchema = tool.schema.enum([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
])
const revisionSchema = tool.schema
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._/@{}~^+/\-]+$/)
  .refine((value) => !value.startsWith("-"), "Revision cannot begin with a dash")

export type GitInspectArgs = {
  operation: "status" | "diff" | "log" | "show" | "branch" | "rev-parse"
  revision?: string
  compareTo?: string
  staged?: boolean
  limit?: number
}

function validatedRevision(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined

  const result = revisionSchema.safeParse(value)
  if (!result.success) throw new Error(`${name} is not a safe Git revision`)
  return result.data
}

function rejectArguments(condition: boolean, operation: string): void {
  if (condition) throw new Error(`Unsupported arguments for Git ${operation} inspection`)
}

export function buildGitEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const environment = Object.fromEntries(
    Object.entries(source).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  )
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null"

  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  }
}

export function buildGitArguments(input: GitInspectArgs): string[] {
  const revision = validatedRevision(input.revision, "revision")
  const compareTo = validatedRevision(input.compareTo, "compareTo")
  const hasLimit = input.limit !== undefined
  const limit = input.limit ?? 20

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer between 1 and 100")
  }

  switch (input.operation) {
    case "status":
      rejectArguments(Boolean(revision || compareTo || input.staged || hasLimit), "status")
      return [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "--no-pager",
        "status",
        "--short",
        "--branch",
        "--untracked-files=normal",
      ]

    case "diff": {
      rejectArguments(hasLimit, "diff")
      rejectArguments(Boolean(compareTo && !revision), "diff")
      rejectArguments(Boolean(input.staged && (revision || compareTo)), "diff")

      const args = [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
      ]
      if (input.staged) args.push("--cached")
      if (revision) args.push(revision)
      if (compareTo) args.push(compareTo)
      args.push("--", ".", ...protectedPathspecs)
      return args
    }

    case "log":
      rejectArguments(Boolean(compareTo || input.staged), "log")
      return [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "--no-pager",
        "log",
        "--oneline",
        "--decorate",
        `--max-count=${limit}`,
        ...(revision ? [revision] : []),
      ]

    case "show":
      rejectArguments(Boolean(compareTo || input.staged || hasLimit), "show")
      if (!revision) throw new Error("Git show inspection requires a revision")
      return [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "--no-pager",
        "show",
        "--format=fuller",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        revision,
        "--",
        ".",
        ...protectedPathspecs,
      ]

    case "branch":
      rejectArguments(Boolean(revision || compareTo || input.staged || hasLimit), "branch")
      return [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "--no-pager",
        "branch",
        "--show-current",
      ]

    case "rev-parse":
      rejectArguments(Boolean(compareTo || input.staged || hasLimit), "rev-parse")
      return [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "--no-pager",
        "rev-parse",
        "--verify",
        `${revision ?? "HEAD"}^{commit}`,
      ]
  }
}

async function runGit(
  worktree: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const result = await runBounded(["git", "-C", worktree, ...args], {
    signal,
    env: buildGitEnvironment(Bun.env),
    maxStdoutBytes: maximumOutputLength,
    maxStderrBytes: 32_000,
    timeoutMs: 15_000,
  })

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || `Git inspection exited with status ${result.exitCode}`,
    )
  }
  return result.stdout
}

async function resolveCommit(
  worktree: string,
  revision: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const output = await runGit(
      worktree,
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "--no-pager",
        "rev-parse",
        "--verify",
        `${revision}^{commit}`,
      ],
      signal,
    )
    const commit = output.trim()
    if (/^[0-9a-f]{40,64}$/i.test(commit)) return commit
  } catch {
    // Normalize Git's version-dependent object-type errors at the tool boundary.
  }
  throw new Error("Git revision must resolve to a commit")
}

async function assertGitWorktree(worktree: string, signal: AbortSignal): Promise<string> {
  const root = await realpath(worktree)
  const output = await runGit(
    root,
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "--no-pager",
      "rev-parse",
      "--show-toplevel",
    ],
    signal,
  )
  const repositoryRoot = await realpath(output.trim())
  if (repositoryRoot !== root) {
    throw new Error("Git repository root does not match active worktree")
  }
  return root
}

export const nativeSwarmGitInspectTool = tool({
  description:
    "Inspect trusted Git repository state through fixed, non-shell operations that exclude protected environment and secrets paths.",
  args: {
    operation: operationSchema.describe("Fixed inspection operation to run"),
    revision: revisionSchema
      .optional()
      .describe("Optional safe revision for diff or log; required for show"),
    compareTo: revisionSchema
      .optional()
      .describe("Optional second safe revision used only with diff"),
    staged: tool.schema
      .boolean()
      .optional()
      .describe("Inspect the staged diff; cannot be combined with revisions"),
    limit: tool.schema
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum log entries, from 1 through 100"),
  },
  async execute(args, context) {
    if (!allowedAgents.has(context.agent)) {
      throw new Error("Git inspection is not available to this agent")
    }

    const worktree = await assertGitWorktree(context.worktree, context.abort)
    const safeArgs = { ...args }
    if (safeArgs.revision) {
      safeArgs.revision = await resolveCommit(worktree, safeArgs.revision, context.abort)
    }
    if (safeArgs.compareTo) {
      safeArgs.compareTo = await resolveCommit(worktree, safeArgs.compareTo, context.abort)
    }

    const gitArguments = buildGitArguments(safeArgs)
    const stdout = await runGit(worktree, gitArguments, context.abort)

    return stdout
  },
})
