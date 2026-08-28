import { tool } from "@opencode-ai/plugin"

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
      return ["--no-pager", "status", "--short", "--branch", "--untracked-files=normal"]

    case "diff": {
      rejectArguments(hasLimit, "diff")
      rejectArguments(Boolean(compareTo && !revision), "diff")
      rejectArguments(Boolean(input.staged && (revision || compareTo)), "diff")

      const args = ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-renames"]
      if (input.staged) args.push("--cached")
      if (revision) args.push(revision)
      if (compareTo) args.push(compareTo)
      args.push("--", ".", ...protectedPathspecs)
      return args
    }

    case "log":
      rejectArguments(Boolean(compareTo || input.staged), "log")
      return [
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
      return ["--no-pager", "branch", "--show-current"]

    case "rev-parse":
      rejectArguments(Boolean(compareTo || input.staged || hasLimit), "rev-parse")
      return ["--no-pager", "rev-parse", "--verify", `${revision ?? "HEAD"}^{commit}`]
  }
}

async function runGit(
  worktree: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const child = Bun.spawn(["git", "-C", worktree, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    signal,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Git inspection exited with status ${exitCode}`)
  }
  return stdout
}

async function resolveCommit(
  worktree: string,
  revision: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const output = await runGit(
      worktree,
      ["--no-pager", "rev-parse", "--verify", `${revision}^{commit}`],
      signal,
    )
    const commit = output.trim()
    if (/^[0-9a-f]{40,64}$/i.test(commit)) return commit
  } catch {
    // Normalize Git's version-dependent object-type errors at the tool boundary.
  }
  throw new Error("Git revision must resolve to a commit")
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

    const safeArgs = { ...args }
    if (safeArgs.revision) {
      safeArgs.revision = await resolveCommit(context.worktree, safeArgs.revision, context.abort)
    }
    if (safeArgs.compareTo) {
      safeArgs.compareTo = await resolveCommit(context.worktree, safeArgs.compareTo, context.abort)
    }

    const gitArguments = buildGitArguments(safeArgs)
    const stdout = await runGit(context.worktree, gitArguments, context.abort)

    if (stdout.length <= maximumOutputLength) return stdout
    return `${stdout.slice(0, maximumOutputLength)}\n[output truncated]`
  },
})
