import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildGitArguments, nativeSwarmGitInspectTool } from "../src/git"

function runGit(directory: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr))
  }
}

function gitOutput(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr))
  }
  return new TextDecoder().decode(result.stdout).trim()
}

describe("hardened git inspection", () => {
  test("builds diff commands with external execution disabled and protected paths excluded", () => {
    const args = buildGitArguments({ operation: "diff", revision: "origin/main" })

    expect(args).toContain("--no-ext-diff")
    expect(args).toContain("--no-textconv")
    expect(args).toContain("--")
    expect(args).toContain(":(glob,exclude)**/.env.*")
    expect(args).toContain(":(glob,exclude)**/*.env")
    expect(args).toContain(":(glob,exclude)**/secrets/**")
  })

  test("rejects revisions that could become options, path lookups, or shell syntax", () => {
    for (const revision of ["--output=/tmp/leak", "HEAD:.env", "HEAD;touch-pwned", "HEAD main"]) {
      expect(() => buildGitArguments({ operation: "diff", revision })).toThrow()
    }
  })

  test("does not accept comparison arguments for fixed operations", () => {
    expect(() =>
      buildGitArguments({ operation: "status", revision: "HEAD" }),
    ).toThrow()
    expect(() =>
      buildGitArguments({ operation: "diff", staged: true, revision: "HEAD" }),
    ).toThrow()
  })

  test("rejects callers outside the two inspection workers before spawning git", async () => {
    const context = {
      agent: "workflow-director",
      worktree: process.cwd(),
    } as ToolContext

    await expect(
      nativeSwarmGitInspectTool.execute({ operation: "status" }, context),
    ).rejects.toThrow("not available")
  })

  test("runs a safe status inspection for an allowed worker", async () => {
    const context = {
      agent: "swarm-reviewer",
      worktree: process.cwd(),
      abort: new AbortController().signal,
    } as ToolContext

    const output = await nativeSwarmGitInspectTool.execute({ operation: "status" }, context)

    expect(output).toContain("## feat/native-swarm-config")
  })

  test("excludes protected file contents from a real repository diff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-swarms-git-"))

    try {
      await mkdir(join(directory, "secrets"))
      await Bun.write(join(directory, "safe.ts"), "export const value = 1\n")
      await Bun.write(join(directory, ".env"), "TOKEN=secret-one\n")
      await Bun.write(join(directory, "secrets", "key.txt"), "secret-key-one\n")
      runGit(directory, "init", "-b", "main")
      runGit(directory, "add", ".")
      runGit(
        directory,
        "-c",
        "user.name=Native Swarms Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "initial",
      )

      await Bun.write(join(directory, "safe.ts"), "export const value = 2\n")
      await Bun.write(join(directory, ".env"), "TOKEN=secret-two\n")
      await Bun.write(join(directory, "secrets", "key.txt"), "secret-key-two\n")

      const context = {
        agent: "swarm-reviewer",
        worktree: directory,
        abort: new AbortController().signal,
      } as ToolContext
      const protectedBlob = gitOutput(directory, "rev-parse", "HEAD:.env")

      await expect(
        nativeSwarmGitInspectTool.execute(
          { operation: "show", revision: protectedBlob },
          context,
        ),
      ).rejects.toThrow("commit")

      const output = await nativeSwarmGitInspectTool.execute({ operation: "diff" }, context)

      expect(typeof output).toBe("string")
      if (typeof output !== "string") throw new Error("Expected text output")
      expect(output).toContain("safe.ts")
      expect(output).toContain("export const value = 2")
      expect(output).not.toContain(".env")
      expect(output).not.toContain("secret-two")
      expect(output).not.toContain("key.txt")
      expect(output).not.toContain("secret-key-two")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
