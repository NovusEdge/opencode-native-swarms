import { describe, expect, test } from "bun:test"
import { runBounded } from "../src/process"

describe("bounded subprocesses", () => {
  test("terminates output that exceeds the byte cap", async () => {
    await expect(
      runBounded([process.execPath, "-e", "process.stdout.write('x'.repeat(4096))"], {
        maxStdoutBytes: 128,
        maxStderrBytes: 128,
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow("output limit")
  })

  test("terminates commands that exceed the timeout", async () => {
    await expect(
      runBounded([process.execPath, "-e", "await Bun.sleep(10_000)"], {
        maxStdoutBytes: 128,
        maxStderrBytes: 128,
        timeoutMs: 50,
      }),
    ).rejects.toThrow("timed out")
  })
})
