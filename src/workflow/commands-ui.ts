import type { Config } from "@opencode-ai/plugin"

export const workflowCommand = {
  description: "Validate, run, inspect, or manage a workflow",
  agent: "workflow-director",
  subtask: false,
  template: "Manage the workflow using only the validated subcommand and arguments:\n$ARGUMENTS",
} satisfies NonNullable<Config["command"]>[string]

export const WORKFLOW_SUBCOMMANDS = ["validate", "run", "status", "cancel", "resume", "cleanup"] as const
export function validateWorkflowCommand(argumentsText: string): { subcommand: typeof WORKFLOW_SUBCOMMANDS[number]; arguments: string } {
  const [subcommand, ...rest] = argumentsText.trim().split(/\s+/)
  if (!(WORKFLOW_SUBCOMMANDS as readonly string[]).includes(subcommand)) throw new Error("Unknown /workflow subcommand")
  return { subcommand: subcommand as typeof WORKFLOW_SUBCOMMANDS[number], arguments: rest.join(" ") }
}
