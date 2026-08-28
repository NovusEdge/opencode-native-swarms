import { tool } from "@opencode-ai/plugin"
import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep, win32 } from "node:path"

const allowedAgents = new Set([
  "workflow-director",
  "swarm-researcher",
  "swarm-reviewer",
  "swarm-tester",
])
const maximumFileBytes = 200_000

function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export function isProtectedReadPath(path: string): boolean {
  const segments = path.split(/[\\/]+/).filter(Boolean)
  return segments.some((segment, index) => {
    if (segment === "secrets") return true
    const isFinalSegment = index === segments.length - 1
    if (
      isFinalSegment &&
      (segment === ".env.example" || segment.endsWith(".env.example"))
    ) {
      return false
    }
    return (
      segment === ".env" ||
      segment.startsWith(".env.") ||
      segment.endsWith(".env") ||
      segment.includes(".env.")
    )
  })
}

export async function resolveReadablePath(worktree: string, requested: string): Promise<string> {
  if (requested.includes("\0")) throw new Error("Read path contains a null byte")
  if (isAbsolute(requested) || win32.isAbsolute(requested)) {
    throw new Error("Read path must be relative to the active worktree")
  }

  const root = await realpath(worktree)
  const lexicalTarget = resolve(root, requested)
  if (!isInside(root, lexicalTarget)) throw new Error("Read path resolves outside the worktree")

  const lexicalRelative = relative(root, lexicalTarget)
  if (isProtectedReadPath(lexicalRelative)) throw new Error("Read path is protected")

  const canonicalTarget = await realpath(lexicalTarget)
  if (!isInside(root, canonicalTarget)) throw new Error("Read target resolves outside the worktree")

  const canonicalRelative = relative(root, canonicalTarget)
  if (isProtectedReadPath(canonicalRelative)) throw new Error("Read target is protected")
  return canonicalTarget
}

async function readBoundedText(path: string): Promise<string> {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(path, constants.O_RDONLY | noFollow)

  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error("Read target is not a regular file")
    if (metadata.nlink > 1) throw new Error("Read target is linked to another file")

    const buffer = Buffer.alloc(maximumFileBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maximumFileBytes) {
      throw new Error(`Read target exceeds ${maximumFileBytes} bytes`)
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))
    } catch {
      throw new Error("Read target is not valid UTF-8 text")
    }
  } finally {
    await handle.close()
  }
}

export const nativeSwarmReadTool = tool({
  description:
    "Read a bounded UTF-8 project file after resolving symlinks, enforcing worktree containment, and denying environment and secrets paths.",
  args: {
    path: tool.schema
      .string()
      .min(1)
      .max(4_096)
      .describe("File path relative to the active worktree"),
    offset: tool.schema
      .number()
      .int()
      .min(1)
      .optional()
      .describe("One-based first line to return"),
    limit: tool.schema
      .number()
      .int()
      .min(1)
      .max(2_000)
      .optional()
      .describe("Maximum number of lines to return"),
  },
  async execute(args, context) {
    if (!allowedAgents.has(context.agent)) {
      throw new Error("Protected project read is not available to this agent")
    }

    const path = await resolveReadablePath(context.worktree, args.path)
    const content = await readBoundedText(path)
    const offset = args.offset ?? 1
    const limit = args.limit ?? 500
    const lines = content.split(/\r?\n/)
    const selected = lines.slice(offset - 1, offset - 1 + limit)

    return selected.map((line, index) => `${offset + index}: ${line}`).join("\n")
  },
})
