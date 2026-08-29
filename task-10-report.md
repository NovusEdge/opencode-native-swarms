# Task 10 report

## Outcome

Prepared sanitized v0.2.0 dogfood evidence and corrected release limitations.
The installed-plugin matrix is blocked by the configured provider returning
HTTP 401 `CreditsError` before any agent prompt or workflow launch. No GitHub,
tag, release, package, or external-service write was performed.

## Evidence

- `opencode debug config` confirmed one installed checkout and the workflow
  agent/tool surface.
- Attempted session hash: `9f7a4a2d1ca6bfc9` (raw ID intentionally omitted).
- Candidate: `8539915313781856cade42b7fad31b9310e483d3`.
- Focused local workflow behavior: `bun test src/workflow` — 60 passed, 0
  failed, 179 expectations across 9 files.
- Full installed-plugin scenario status and safety checks: see
  `docs/dogfood/v0.2.0.md`.

## Final gates

Run once after evidence edits:

| Gate | Result |
| --- | --- |
| `bun run check` | pass — 104 tests, 0 failures, 346 expectations across 17 files; TypeScript passed |
| `bun run package:check` | pass — package contents accepted |
| `uvx --from pre-commit==4.6.2 pre-commit run --all-files` | pass — all hooks passed, including secrets and Bun tests/typecheck |

The candidate must not be tagged or published until a provider-enabled live
matrix completes.
