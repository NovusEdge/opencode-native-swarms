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

Review hardening added serialized state read-modify-write updates, scheduler
reservations for concurrency, bounded asynchronous status waits with timeout,
cancellation guards, persisted workspace evidence, event correlation, and
repository evidence on launch.

Final review-fix pass adds cross-runtime atomic state updates, cancellation
checks around native session creation/prompting, strict bound-session event
correlation, consumed approval recording, output byte caps, lost-session
classification, and optional host hook registration.

The follow-up used behavior-first tests: host hook absence and approval replay
were confirmed failing before their fixes, then the focused suite was rerun.
Final verification: 4 runtime tests passed and TypeScript typecheck passed.
