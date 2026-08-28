# Task 6 report: workflow planning and repository state

Implemented deterministic workflow planning and lifecycle/state persistence.

`planner.ts` validates dependencies, cycles, declared output references and
types, workspace modes and repository identity, policy capabilities/scopes,
resource ceilings, and writer overlap/handoff rules. Kahn planning uses stable
step-ID ordering and returns deeply frozen plans. Workflow and step transition
helpers reject every illegal transition.

`state.ts` provides repository-keyed XDG storage through injected environment
and filesystem adapters. Writes are lock-serialized, sanitized, temporary and
atomically replaced where the adapter supports rename; fsync is attempted when
available. Missing/incomplete records remain recoverable from the last complete
record, and event/list APIs are exposed for runtime resume/stale hooks.

Focused verification:

`bun test src/workflow/planner.test.ts src/workflow/state.test.ts && bun run typecheck`

Result: 5 tests passed, 0 failed; TypeScript check passed.

Review follow-up hardens command allow/deny-floor evaluation, workflow and
step scope ceilings, resource limits, transitive input reachability, deep
cloning, and canonical hashing. State identity now requires canonical common
directory metadata; XDG configuration is authoritative, writes retain a
complete backup, and events use the same atomic protocol with validation and
clear corruption failures.

The final review round makes command authority mandatory, enforces installation
protected paths, preserves schema hashes, validates canonical repository/XDG
inputs, recovers corrupt primaries from complete backups, validates nested
records consistently, and adds drift-aware persisted workflow transitions and
revalidation hooks.

The subsequent hardening round adds broad protected-scope rejection, exact
workspace evidence matching, shared immutable definition/step graph, and
lock-serialized persisted step transitions and resumability checks with drift
guards.
