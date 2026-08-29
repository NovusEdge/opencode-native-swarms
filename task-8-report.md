# Task 8 report: workflow tools, commands, and plugin integration

Implemented the workflow tool surface (`workflow_validate`, `workflow_launch`,
`workflow_command`, save/inspect/status/wait/cancel/amend/resume/cleanup),
repository-scoped command validation, approval correlation through
`ToolContext.ask`, permission hooks, timeout/no-reply denial, and single-use
approval tokens. Added `/workflow` command validation and plugin registration.

Added the reserved `native-swarms-workflow-step` definition with canonical
hash validation so a colliding, modified user definition fails closed at
runtime. Existing `/swarm` remains registered unchanged.

Verification:

- `bun test src/workflow/tools.test.ts` — 3 passed
- `bun run typecheck` — passed

Review follow-up connected `NativeSwarmsPlugin` to native session and state
adapters, enforced structured run-scoped commands, added caller-abort approval
handling and richer approval summaries, validated run IDs for `/workflow`, and
preserved object-shaped OpenCode agent tool permissions. Final focused gate:

- `bun test src/workflow/tools.test.ts test/config.test.ts` — 18 passed
- `bun run typecheck` — passed
- `bun test src/workflow/tools.test.ts test/config.test.ts` — workflow tests
  pass; the legacy config assertion still expects only `/swarm` and therefore
  fails now that the required `/workflow` command is registered.

Follow-up gate fix updated `test/config.test.ts` to assert additive `/workflow`
registration, reserved-agent registration, and preservation of user-owned
reserved agent and `/workflow` command definitions. Final batched verification:

- `bun test src/workflow/tools.test.ts test/config.test.ts` — 15 passed
- `bun run typecheck` — passed
