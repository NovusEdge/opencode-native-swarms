import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSearchArguments, nativeSwarmSearchTool } from "../src/search"

describe("protected project search", () => {
  test("builds a worktree-only search with protected exclusions", () => {
    const args = buildSearchArguments("exportedName")

    expect(args).toContain("--hidden")
    expect(args).toContain("!.env.*")
    expect(args).toContain("!**/*.env")
    expect(args).toContain("!**/secrets/**")
    expect(args.slice(-3)).toEqual(["--", "exportedName", "."])
  })

  test("rejects callers outside the swarm agents", async () => {
    const context = {
      agent: "build",
      worktree: process.cwd(),
      abort: new AbortController().signal,
    } as ToolContext

    await expect(
      nativeSwarmSearchTool.execute({ pattern: "anything" }, context),
    ).rejects.toThrow("not available")
  })

  test("finds project content without returning protected files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-swarms-search-"))

    try {
      await mkdir(join(directory, "secrets"))
      await Bun.write(join(directory, "safe.ts"), "export const searchable = true\n")
      await Bun.write(join(directory, ".env"), "searchable=secret-env\n")
      await Bun.write(join(directory, ".env.example"), "searchable=example-env\n")
      await Bun.write(join(directory, "secrets", "key.txt"), "searchable=secret-key\n")
      const context = {
        agent: "swarm-researcher",
        worktree: directory,
        abort: new AbortController().signal,
      } as ToolContext

      const output = await nativeSwarmSearchTool.execute({ pattern: "searchable" }, context)

      expect(typeof output).toBe("string")
      if (typeof output !== "string") throw new Error("Expected text output")
      expect(output).toContain("safe.ts")
      expect(output).not.toContain(".env")
      expect(output).not.toContain("example-env")
      expect(output).not.toContain("key.txt")
      expect(output).not.toContain("secret-key")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
