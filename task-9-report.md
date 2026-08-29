# Task 9 report

Implemented the v0.2.0 adversarial coverage, packaging, and documentation.

## Changes

- Added `test/workflow-adversarial.test.ts` covering escalation/shell
  composition, forged runtime status, symlink escape, overlapping writer globs,
  policy-hash drift, stale resume, cleanup data-loss refusal, and trusted-project
  command exactness.
- Resume revalidation failures now persist `stale` state before propagating the
  failure.
- Added exact workflow runtime paths to the package allowlist and changed npm
  package metadata to enumerate runtime files, excluding tests and local
  artifacts. The package checker explicitly rejects workflow tests and
  `.superpowers` paths.
- Bumped package version to `0.2.0` and added README, dogfood, and release notes.

## Verification

- `bun test test/workflow-adversarial.test.ts`: pass (8 tests).
- `bun run package:check`: pass.
- `bun run check`: blocked by six pre-existing runtime tests that provide a
  shortened reserved-agent definition whose hash does not match the immutable
  safe definition (`src/workflow/runtime.test.ts`). All other tests passed.
- `uvx --from pre-commit==4.6.2 pre-commit run --all-files`: hygiene and secret
  checks passed; Bun check reports the same six runtime failures.

## Residual follow-ups

- Update the runtime test fixture (or its compatibility contract) to use the
  canonical reserved-agent definition, then rerun the full gate.
- Execute installed-plugin dogfood and replace pending entries in
  `docs/dogfood/v0.2.0.md` before public tagging.

## Final full-gate rerun

The shortened runtime fixtures were corrected to import the canonical
`reservedWorkflowAgent`; runtime security validation was not weakened.

- `bun run check`: pass — 102 tests, 0 failures, TypeScript clean.
- `bun run package:check`: pass.
- `uvx --from pre-commit==4.6.2 pre-commit run --all-files`: pass — all hooks,
  including Bun tests and typecheck.
