export type BoundedProcessOptions = {
  signal?: AbortSignal
  cwd?: string
  env?: Record<string, string | undefined>
  maxStdoutBytes: number
  maxStderrBytes: number
  timeoutMs: number
}
export type BoundedProcessResult = {
  stdout: string
  stderr: string
  exitCode: number
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onLimit: () => void,
): Promise<{ text: string; limited: boolean }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) return { text: text + decoder.decode(), limited: false }

    const remaining = maximumBytes - bytes
    if (value.byteLength > remaining) {
      if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true })
      onLimit()
      await reader.cancel()
      return { text, limited: true }
    }

    bytes += value.byteLength
    text += decoder.decode(value, { stream: true })
  }
}

export async function runBounded(
  command: string[],
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  })
  let timedOut = false
  let outputLimited = false
  const terminate = () => child.kill("SIGKILL")
  const timeout = setTimeout(() => {
    timedOut = true
    terminate()
  }, options.timeoutMs)

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readLimited(child.stdout, options.maxStdoutBytes, () => {
        outputLimited = true
        terminate()
      }),
      readLimited(child.stderr, options.maxStderrBytes, () => {
        outputLimited = true
        terminate()
      }),
      child.exited,
    ])

    if (timedOut) throw new Error(`Command timed out after ${options.timeoutMs}ms`)
    if (outputLimited) throw new Error("Command exceeded its output limit")
    return { stdout: stdout.text, stderr: stderr.text, exitCode }
  } finally {
    clearTimeout(timeout)
  }
}
