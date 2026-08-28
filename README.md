# OpenCode Native Swarms

Permission-scoped native background-agent workflows for OpenCode. The plugin
adds a primary workflow director, three bounded workers, and a `/swarm` command
without pinning a model or taking over identically named user configuration.

This is deliberately a non-writing first stage: it can research, review, and
run narrow checks in trusted projects, but it cannot dispatch edits, commits,
pushes, or external-service writes.

## Requirements

- OpenCode 1.18.25 or newer
- Native background subagents enabled with
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`
- Bun for local development

The plugin omits every agent's `model` field. OpenCode therefore uses the
models selected by your own configuration.

## Install from a local checkout

Clone the repository somewhere you intend to keep it, install its development
dependencies, and register the absolute checkout path:

```bash
git clone https://github.com/NovusEdge/opencode-native-swarms.git
cd opencode-native-swarms
bun install
opencode plugin --global "$PWD"
```

Restart OpenCode after installation. The plugin path should appear once in the
global `plugin` array, and `opencode debug config` should list the four agents
and the `swarm` command.

## What it adds

| Name | Mode | Boundary |
| --- | --- | --- |
| `workflow-director` | primary | Reads and searches locally, asks questions, and delegates only to the three workers below |
| `swarm-researcher` | subagent | Reads and searches locally and consults web sources; no shell or delegation |
| `swarm-reviewer` | subagent | Reads locally and uses the plugin's hardened, non-shell Git inspection tool |
| `swarm-tester` | subagent | Uses hardened Git inspection and approved test, lint, and type-check command families |
| `/swarm` | command | Starts `workflow-director` for the supplied objective |

Every agent is deny-by-default. Reads of `.env`, environment-file variants,
and `secrets/**` are denied, with example environment files explicitly allowed.
The reviewer has no shell access. Git inspection is implemented as fixed
argument-array operations: arbitrary paths and flags are not accepted,
external diff and text-conversion drivers are disabled, and protected paths
are excluded from patch output. The tester's shell permission denies everything
before enumerating its small test-command allowlist. Test scripts still execute
project code, so use the tester only in repositories you already trust.

If your configuration already defines one of these names, your definition wins
and the plugin leaves that object unchanged.

## Usage

From an OpenCode session:

```text
/swarm inspect this change for correctness, verify its focused tests, and summarize any gaps
```

The director may launch at most four independent background assignments while
the main conversation remains available. It synthesizes only returned results
and produces an implementation brief when the objective would require edits.

## Development

```bash
bun install
bun run check
```

`bun run check` runs the behavior tests and strict TypeScript checking. To
inspect the fully resolved configuration without invoking a model:

```bash
OPENCODE_CONFIG_CONTENT='{"plugin":["/absolute/path/to/opencode-native-swarms"]}' \
  opencode debug config
```

## Uninstall

Remove the checkout's absolute path from the `plugin` array in your global
OpenCode configuration, then restart OpenCode. Removing the plugin does not
delete the repository or alter your existing agent and command files.

## License

[MIT](LICENSE)
