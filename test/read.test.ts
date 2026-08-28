import { expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import { link, mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeSwarmsPlugin } from "../src/index"

test("reads ordinary project files through the protected tool", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-swarms-read-"))

  try {
    await Bun.write(join(directory, "safe.ts"), "export const safe = true\n")
    await Bun.write(join(directory, ".env.example"), "TOKEN=placeholder\n")
    const hooks = await NativeSwarmsPlugin({} as never)
    const readTool = hooks.tool?.swarm_read
    expect(readTool).toBeDefined()
    if (!readTool) return

    const output = await readTool.execute(
      { path: "safe.ts" },
      {
        agent: "swarm-researcher",
        worktree: directory,
        abort: new AbortController().signal,
      } as ToolContext,
    )

    expect(typeof output).toBe("string")
    if (typeof output !== "string") throw new Error("Expected text output")
    expect(output).toContain("export const safe = true")
    const example = await readTool.execute({ path: ".env.example" }, {
      agent: "swarm-researcher",
      worktree: directory,
      abort: new AbortController().signal,
    } as ToolContext)
    expect(typeof example).toBe("string")
    if (typeof example !== "string") throw new Error("Expected text output")
    expect(example).toContain("TOKEN=placeholder")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects protected and escaping symlink targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-swarms-read-"))
  const external = await mkdtemp(join(tmpdir(), "native-swarms-external-"))

  try {
    await mkdir(join(directory, "secrets"))
    await mkdir(join(directory, ".env.local"))
    await mkdir(join(directory, ".env.example"))
    await mkdir(join(directory, "nested", "app.env.example"), { recursive: true })
    await Bun.write(join(directory, ".env"), "TOKEN=protected\n")
    await Bun.write(join(directory, ".env.local", "token.txt"), "nested-protected\n")
    await Bun.write(join(directory, ".env.example", "token.txt"), "example-dir-secret\n")
    await Bun.write(
      join(directory, "nested", "app.env.example", "token.txt"),
      "nested-example-dir-secret\n",
    )
    await Bun.write(join(directory, "secrets", "key.txt"), "protected-key\n")
    await Bun.write(join(external, "outside.txt"), "outside-secret\n")
    await symlink(".env", join(directory, "safe-looking.txt"))
    await symlink(join(external, "outside.txt"), join(directory, "outside-link.txt"))
    await link(join(directory, ".env"), join(directory, "hardlink.txt"))

    const hooks = await NativeSwarmsPlugin({} as never)
    const readTool = hooks.tool?.swarm_read
    expect(readTool).toBeDefined()
    if (!readTool) return
    const context = {
      agent: "swarm-reviewer",
      worktree: directory,
      abort: new AbortController().signal,
    } as ToolContext

    await expect(readTool.execute({ path: ".env" }, context)).rejects.toThrow(
      "protected",
    )
    await expect(
      readTool.execute({ path: "secrets/key.txt" }, context),
    ).rejects.toThrow("protected")
    await expect(
      readTool.execute({ path: ".env.local/token.txt" }, context),
    ).rejects.toThrow("protected")
    await expect(
      readTool.execute({ path: ".env.example/token.txt" }, context),
    ).rejects.toThrow("protected")
    await expect(
      readTool.execute({ path: "nested/app.env.example/token.txt" }, context),
    ).rejects.toThrow("protected")
    await expect(
      readTool.execute({ path: "safe-looking.txt" }, context),
    ).rejects.toThrow("protected")
    await expect(
      readTool.execute({ path: "outside-link.txt" }, context),
    ).rejects.toThrow("outside")
    await expect(readTool.execute({ path: "hardlink.txt" }, context)).rejects.toThrow(
      "linked",
    )
    await expect(
      readTool.execute({ path: join(external, "outside.txt") }, context),
    ).rejects.toThrow("relative")
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})
