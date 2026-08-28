import { expect, test } from "bun:test"

const root = `${import.meta.dir}/..`

async function readProjectFile(path: string): Promise<string> {
  return Bun.file(`${root}/${path}`).text()
}

test("pre-commit runs repository hygiene, secret scanning, and Bun checks", async () => {
  const config = await readProjectFile(".pre-commit-config.yaml")

  expect(config).toContain("https://github.com/pre-commit/pre-commit-hooks")
  expect(config).toContain("https://github.com/gitleaks/gitleaks")
  expect(config).toContain("id: gitleaks")
  expect(config).toContain("id: bun-check")
  expect(config).toContain("entry: bun run check")
  expect(config).toContain("pass_filenames: false")
})

test("package scripts run the pinned pre-commit tool through uv", async () => {
  const packageJson = JSON.parse(await readProjectFile("package.json")) as {
    scripts?: Record<string, string>
  }

  expect(packageJson.scripts?.["hooks:install"]).toBe(
    "uvx --from pre-commit==4.6.2 pre-commit install --install-hooks",
  )
  expect(packageJson.scripts?.["hooks:run"]).toBe(
    "uvx --from pre-commit==4.6.2 pre-commit run --all-files",
  )
  expect(packageJson.scripts?.["package:check"]).toBe(
    "bun scripts/check-package.ts",
  )
})

test("CI installs locked dependencies and exercises the local quality gates", async () => {
  const workflow = await readProjectFile(".github/workflows/ci.yml")
  const readme = await readProjectFile("README.md")

  expect(workflow).toContain("bun install --frozen-lockfile")
  expect(workflow).toContain("bun run hooks:run")
  expect(workflow).toContain("bun run package:check")
  expect(workflow).toContain("docker://ghcr.io/gitleaks/gitleaks@sha256:")
  expect(workflow).toContain("args: git /github/workspace")
  expect(workflow).toContain("persist-credentials: false")
  expect(readme).toContain("actions/workflows/ci.yml/badge.svg")
  expect(readme).toContain("docs.astral.sh/uv/getting-started/installation")
})
