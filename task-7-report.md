# Task 7 report: native workflow runtime

Implemented `src/workflow/runtime.ts` with injected OpenCode session/state
adapters, reserved-agent validation, session binding and built-in tool defense,
asynchronous DAG scheduling, bounded waits, output validation, failure policy,
cancellation, resume/amend hooks, and workspace cleanup delegation.

Added focused runtime tests covering asynchronous launch and the bound-session
built-in tool denial boundary.

Verification:

`bun test src/workflow/runtime.test.ts && bun run typecheck`

Result: 2 tests passed; TypeScript check passed.
