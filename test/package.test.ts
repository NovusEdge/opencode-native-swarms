import { expect, test } from "bun:test"
import {
  assertPackageFiles,
  expectedPackageFiles,
  packageFileDifferences,
} from "../scripts/check-package"

test("accepts the intended package file set in any order", () => {
  expect(() => assertPackageFiles([...expectedPackageFiles].reverse())).not.toThrow()
})

test("reports missing and unexpected package files", () => {
  const actual = expectedPackageFiles.filter((path) => path !== "LICENSE")
  const differences = packageFileDifferences([...actual, "test/config.test.ts"])

  expect(differences).toEqual({
    missing: ["LICENSE"],
    unexpected: ["test/config.test.ts"],
  })
  expect(() => assertPackageFiles([...actual, "test/config.test.ts"])).toThrow(
    "missing: LICENSE; unexpected: test/config.test.ts",
  )
})

test("rejects workflow tests and local superpowers artifacts", () => {
  expect(() => assertPackageFiles([...expectedPackageFiles, "src/workflow/runtime.test.ts"])).toThrow(/excluded/i)
  expect(() => assertPackageFiles([...expectedPackageFiles, ".superpowers/sdd/state.json"])).toThrow(/excluded/i)
})
