import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildGitArguments,
  buildGitEnvironment,
  nativeSwarmGitInspectTool,
} from "../src/git"

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

    expect(args.slice(0, 3)).toEqual(["--no-optional-locks", "-c", "core.fsmonitor=false"])
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

  test("sanitizes Git-specific environment variables and disables lazy fetching", () => {
    expect(
      buildGitEnvironment({
        PATH: "/usr/bin",
        GIT_DIR: "/tmp/redirected",
        GIT_CONFIG_COUNT: "1",
        git_work_tree: "/tmp/redirected-tree",
      }),
    ).toMatchObject({
      PATH: "/usr/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    })
    expect(
      Object.keys(buildGitEnvironment({ GIT_DIR: "/tmp/redirected" })),
    ).not.toContain("GIT_DIR")
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
    const directory = await mkdtemp(join(tmpdir(), "native-swarms-status-"))

    try {
      await Bun.write(join(directory, "safe.ts"), "export const value = 1\n")
      runGit(directory, "init", "-b", "status-test")
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
      const context = {
        agent: "swarm-reviewer",
        worktree: directory,
        abort: new AbortController().signal,
      } as ToolContext

      const output = await nativeSwarmGitInspectTool.execute({ operation: "status" }, context)

      expect(output).toContain("## status-test")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("ignores inherited Git repository redirection", async () => {
    const intended = await mkdtemp(join(tmpdir(), "native-swarms-intended-"))
    const redirected = await mkdtemp(join(tmpdir(), "native-swarms-redirected-"))
    const originalGitDir = Bun.env.GIT_DIR
    const originalGitWorkTree = Bun.env.GIT_WORK_TREE

    try {
      for (const [directory, branch] of [
        [intended, "intended"],
        [redirected, "redirected"],
      ] as const) {
        await Bun.write(join(directory, "safe.ts"), `export const branch = "${branch}"\n`)
        runGit(directory, "init", "-b", branch)
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
      }

      Bun.env.GIT_DIR = join(redirected, ".git")
      Bun.env.GIT_WORK_TREE = redirected
      const context = {
        agent: "swarm-reviewer",
        worktree: intended,
        abort: new AbortController().signal,
      } as ToolContext

      const output = await nativeSwarmGitInspectTool.execute({ operation: "status" }, context)

      expect(output).toContain("## intended")
      expect(output).not.toContain("redirected")
    } finally {
      if (originalGitDir === undefined) delete Bun.env.GIT_DIR
      else Bun.env.GIT_DIR = originalGitDir
      if (originalGitWorkTree === undefined) delete Bun.env.GIT_WORK_TREE
      else Bun.env.GIT_WORK_TREE = originalGitWorkTree
      await rm(intended, { recursive: true, force: true })
      await rm(redirected, { recursive: true, force: true })
    }
  })

  test("rejects a context directory that is not the repository worktree root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-swarms-root-"))
    const nested = join(directory, "nested")

    try {
      await mkdir(nested)
      await Bun.write(join(directory, "safe.ts"), "export const value = 1\n")
      runGit(directory, "init", "-b", "root-test")
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
      const context = {
        agent: "swarm-reviewer",
        worktree: nested,
        abort: new AbortController().signal,
      } as ToolContext

      await expect(
        nativeSwarmGitInspectTool.execute({ operation: "status" }, context),
      ).rejects.toThrow("Git repository root does not match active worktree")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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
