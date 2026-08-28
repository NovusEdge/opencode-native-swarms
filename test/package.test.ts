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
