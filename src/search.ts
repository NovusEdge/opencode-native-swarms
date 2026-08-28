import { tool } from "@opencode-ai/plugin"
import { runBounded } from "./process"

const allowedAgents = new Set([
  "workflow-director",
  "swarm-researcher",
  "swarm-reviewer",
  "swarm-tester",
])
const protectedGlobs = [
  "!.git/**",
  "!.env",
  "!.env.*",
  "!*.env",
  "!*.env.*",
  "!secrets/**",
  "!**/.env",
  "!**/.env.*",
  "!**/*.env",
  "!**/*.env.*",
  "!**/secrets/**",
] as const

export function buildSearchArguments(pattern: string): string[] {
  const globs = protectedGlobs.flatMap((glob) => ["--glob", glob])
  return [
    "--line-number",
    "--column",
    "--no-heading",
    "--color=never",
    "--hidden",
    ...globs,
    "--",
    pattern,
    ".",
  ]
}

export const nativeSwarmSearchTool = tool({
  description:
    "Search project content without accepting a path and without inspecting environment or secrets files.",
  args: {
    pattern: tool.schema.string().min(1).max(1_000).describe("Ripgrep-compatible search pattern"),
  },
  async execute(args, context) {
    if (!allowedAgents.has(context.agent)) {
      throw new Error("Protected project search is not available to this agent")
    }

    const result = await runBounded(["rg", ...buildSearchArguments(args.pattern)], {
      cwd: context.worktree,
      signal: context.abort,
      maxStdoutBytes: 200_000,
      maxStderrBytes: 32_000,
      timeoutMs: 15_000,
    })

    if (result.exitCode === 1) return "No matches found"
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Project search exited with status ${result.exitCode}`)
    }
    return result.stdout
  },
})
