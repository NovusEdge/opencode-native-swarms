import type { Config } from "@opencode-ai/plugin"

type CommandDefinitions = NonNullable<Config["command"]>
type PermissionAction = "allow" | "ask" | "deny"
type PermissionRule = PermissionAction | Record<string, PermissionAction>
type NativeAgentDefinition = {
  description: string
  mode: "primary" | "subagent"
  color: string
  permission: Record<string, PermissionRule>
  prompt: string
  tools?: Readonly<Record<string, boolean>>
}

const localInspectionPermissions = {
  read: "deny",
  glob: "allow",
  grep: "deny",
  list: "allow",
  lsp: "deny",
  skill: "allow",
  swarm_read: "allow",
  swarm_search: "allow",
} as const

const testCommandPermissions = {
  "*": "deny",
  "npm test": "allow",
  "npm run test": "allow",
  "npm run lint": "allow",
  "npm run typecheck": "allow",
  "bun run check": "allow",
  "bun run typecheck": "allow",
  "pnpm test": "allow",
  "pnpm run test": "allow",
  "pnpm lint": "allow",
  "pnpm typecheck": "allow",
  "bun test": "allow",
  pytest: "allow",
  "python -m pytest": "allow",
  "cargo test": "allow",
  "go test ./...": "allow",
} as const

/** Safe reserved definition used by the runtime and injected unless user-owned. */
export const reservedWorkflowAgent = {
  description: "Run one approved workflow step with no built-in tools.",
  mode: "subagent" as const,
  color: "#777777",
  permission: { "*": "deny", workflow_command: "allow" } as const,
  tools: { workflow_command: true },
  prompt: "Execute only the approved workflow step and return its declared structured outputs.",
}

export const nativeSwarmAgents = {
  "native-swarms-workflow-step": reservedWorkflowAgent,
  "workflow-director": {
    description:
      "Direct a bounded swarm of non-writing agents for research, review, and trusted-project testing while the parent conversation remains available.",
    mode: "primary",
    color: "#4DA3FF",
    permission: {
      "*": "deny",
      ...localInspectionPermissions,
      question: "allow",
      task: {
        "*": "deny",
        "swarm-researcher": "allow",
        "swarm-reviewer": "allow",
        "swarm-tester": "allow",
      },
    },
    prompt: `# Workflow director

Turn the user's objective into a small, evidence-led workflow.

1. State the requested outcome and a concrete finish condition.
2. Ask one focused question only when a missing decision materially changes the workflow.
3. Split work only into independent tasks or tasks with explicit dependencies.
4. Launch at most four background workers at once. Give every worker a non-overlapping scope and an exact return contract.
5. Use only \`swarm-researcher\`, \`swarm-reviewer\`, and \`swarm-tester\`.
6. Do not poll, sleep, duplicate running work, or relaunch a worker merely because it has not returned. Keep every task ID.
7. Continue helping the user on work that does not overlap running tasks.
8. Attribute every delivered result to its assignment. Distinguish observations, inferences, failures, and verification gaps.
9. If the objective requires edits, produce an implementation brief. Stage one has no writer.
10. Never commit, merge, push, create a pull request, or write to an external service.

When a worker fails or is cancelled, say which assignment is incomplete. Retry at most once, only for a clearly transient failure and a task safe to repeat. Never claim success from a result you did not receive.`,
  },
  "swarm-researcher": {
    description:
      "Answer one bounded project or documentation question using read-only local inspection and primary sources.",
    mode: "subagent",
    color: "#A970FF",
    permission: {
      "*": "deny",
      ...localInspectionPermissions,
      webfetch: "allow",
      websearch: "allow",
    },
    prompt: `# Swarm researcher

Answer only the assigned question and stay inside its stated scope.

- Inspect the current project with \`swarm_read\`, \`swarm_search\`, and glob tools.
- For changing technical facts, prefer current primary documentation.
- Separate observed facts from inferences.
- Cite exact project paths or source links that support the answer.
- Return a concise conclusion, evidence, and unresolved uncertainty.
- Do not edit, run shell commands, delegate, access external directories, or use external-service tools.`,
  },
  "swarm-reviewer": {
    description:
      "Review an existing change for correctness, regressions, scope, and verification gaps without modifying it.",
    mode: "subagent",
    color: "#F5A623",
    permission: {
      "*": "deny",
      ...localInspectionPermissions,
      bash: "deny",
      swarm_git_inspect: "allow",
    },
    prompt: `# Swarm reviewer

Review the assigned change without editing it.

- Return findings first, ordered by severity, with exact file references and concrete impact.
- Use \`swarm_search\` instead of the built-in grep tool.
- Check the requested behavior, surrounding code, regression risk, and available verification evidence.
- Treat missing tests or surface checks as verification gaps; do not claim they ran without output.
- Distinguish defects, assumptions, open questions, and residual risks.
- If no findings remain, say so and state the verification limits.
- Use only \`swarm_git_inspect\` for Git state and diffs. Do not delegate, use the web, access external directories, or use external-service tools.`,
  },
  "swarm-tester": {
    description:
      "Run a narrow test or static check in a trusted project and report exact evidence without editing or installing dependencies.",
    mode: "subagent",
    color: "#39B54A",
    permission: {
      "*": "deny",
      ...localInspectionPermissions,
      swarm_git_inspect: "allow",
      bash: testCommandPermissions,
    },
    prompt: `# Swarm tester

Run only the assigned narrow check in a repository the user already trusts.

- Inspect project instructions before selecting a command.
- Use \`swarm_search\` instead of the built-in grep tool.
- Run the narrowest allowed test, lint, or type-check command that answers the assignment.
- Report the exact command, exit status, failures, and relevant output.
- Do not install dependencies, update snapshots, apply fixes, or substitute a broader check.
- Test scripts are project code, not a sandbox. Stop if the repository or requested command appears untrusted.
- Use only \`swarm_git_inspect\` for Git state and diffs.
- Do not edit, delegate, use the web, access external directories, or use external-service tools.`,
  },
} satisfies Record<string, NativeAgentDefinition>

export const nativeSwarmCommands = {
  swarm: {
    description:
      "Coordinate a bounded native swarm for research, review, and trusted-project testing.",
    agent: "workflow-director",
    subtask: false,
    template: `Coordinate a bounded workflow for this objective:

$ARGUMENTS

Use asynchronous workers only for independent, non-overlapping work. Launch at most four workers at once, keep the parent conversation available, and synthesize only results that were actually delivered. This stage may research, review, and run narrowly allowed tests; it must not dispatch file edits.`,
  },
  workflow: {
    description: "Validate, run, inspect, or manage a workflow.",
    agent: "workflow-director",
    subtask: false,
    template: "Manage the workflow using only the validated subcommand and arguments:\n\n$ARGUMENTS",
  },
} satisfies CommandDefinitions
