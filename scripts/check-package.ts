export const expectedPackageFiles = [
  "LICENSE",
  "README.md",
  "package.json",
  "src/config.ts",
  "src/definitions.ts",
  "src/git.ts",
  "src/index.ts",
  "src/process.ts",
  "src/read.ts",
  "src/search.ts",
  "src/workflow/types.ts",
  "src/workflow/schema.ts",
  "src/workflow/policy.ts",
  "src/workflow/commands.ts",
  "src/workflow/workspace.ts",
  "src/workflow/planner.ts",
  "src/workflow/state.ts",
  "src/workflow/runtime.ts",
  "src/workflow/tools.ts",
  "src/workflow/commands-ui.ts",
  "src/workflow/picomatch.d.ts",
  "src/workflow/index.ts",
] as const

type PackResult = {
  files: Array<{ path: string }>
}

export function packageFileDifferences(actualFiles: string[]): {
  missing: string[]
  unexpected: string[]
} {
  const actual = new Set(actualFiles)
  const expected = new Set<string>(expectedPackageFiles)

  return {
    missing: expectedPackageFiles.filter((path) => !actual.has(path)),
    unexpected: [...actual].filter((path) => !expected.has(path)).sort(),
  }
}

export function assertPackageFiles(actualFiles: string[]): void {
  const excluded = actualFiles.filter((path) => /(^|\/)(?:\.superpowers|src\/workflow\/.*\.test\.ts)(\/|$)/.test(path))
  if (excluded.length > 0) throw new Error(`Package contains excluded files: ${excluded.join(", ")}`)
  const { missing, unexpected } = packageFileDifferences(actualFiles)
  if (missing.length === 0 && unexpected.length === 0) return

  const details = [
    missing.length > 0 ? `missing: ${missing.join(", ")}` : undefined,
    unexpected.length > 0 ? `unexpected: ${unexpected.join(", ")}` : undefined,
  ].filter(Boolean)

  throw new Error(`Package contents differ (${details.join("; ")})`)
}

export function checkPackage(): void {
  const result = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  })

  if (result.exitCode !== 0) {
    throw new Error(
      `npm pack failed with exit code ${result.exitCode}: ${result.stderr.toString()}`,
    )
  }

  const packs = JSON.parse(result.stdout.toString()) as PackResult[]
  if (packs.length !== 1) {
    throw new Error(`Expected one package result, received ${packs.length}`)
  }

  assertPackageFiles(packs[0].files.map(({ path }) => path))
}

if (import.meta.main) checkPackage()
