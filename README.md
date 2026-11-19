# dsh-xcode-mcp

A minimal DeepSeek Harness (DSH) bundle that mounts the Xcode MCP server **only** in Sessions that work inside an Xcode project. Pure TypeScript — no Python, no `uv`, no extra runtime dependencies.

DSH has no workspace-level MCP configuration: a profile-level `mcp-client` entry starts one server with a fixed working directory. This bundle closes that gap natively. It watches the live Agent registry, reads each Agent's working directory, finds the nearest ancestor containing a `*.xcodeproj` directory, and loads one `mcp-client` instance through that Agent's own Context, starting `xcrun mcpbridge` with the project root as its working directory. The resulting `mcp__xcode__*` tools are visible only to that Agent, and the child process is disconnected when the Agent is disposed.

## Behavior

- **Per Agent, at creation.** Existing Agents are backfilled when the plugin activates (concurrently); every later `agent/created` event is handled. Subagents get their own Agent and therefore their own MCP process.
- **Discovery.** Starting at the Session's current working directory, walk upward and return the first directory that contains a directory named `*.xcodeproj` (symlinked project directories count). The walk checks the `.git` root itself and then stops; it also stops at the filesystem root. If several projects share one directory, the lexicographically first name is used.
- **No project, no mount.** Sessions outside an Xcode project get no Xcode tools and no placeholder server.
- **Bridge preflight.** With the default `xcrun mcpbridge` launcher, the plugin first runs `xcrun --find mcpbridge` (bounded by 10s). When the bridge is missing (no Xcode 26+, or `xcode-select` points at the Command Line Tools), the mount is skipped with a clear diagnostic instead of MCP connection-failure noise. Custom `command`/`args` are trusted as configured and validated by the MCP client itself.
- **No writes.** The plugin has no manifest file, no Web UI, and performs no filesystem writes.
- **Clean teardown.** Disposing the Agent or disabling the bundle disposes the corresponding `mcp-client` fiber, which closes the stdio transport. An in-flight startup is interrupted on unload rather than waiting for the watchdog.
- **Failure isolation.** A missing working directory, unreadable project tree, failed probe, or MCP startup failure is logged and never fails Agent creation — including when cleaning up a failed mount itself fails.
- **Creation-time decision.** Discovery runs once when the Agent is created. Moving an existing Session to another directory (`workingDirectory.set`) does not re-evaluate the mount in this version.

## Defaults

| Field | Value |
| --- | --- |
| `serverName` | `xcode` |
| `command` | `xcrun` |
| `args` | `["mcpbridge"]` |
| `env` | `{}` |
| `startupTimeoutMs` | `30000` (1–2147483647, Node's timer range) |

`xcrun` ships with macOS at `/usr/bin/xcrun`; `mcpbridge` requires Xcode 26 or newer. Every field is overridable through the bundle row's `config` in the profile patch:

```yaml
- id: xcode-mcp-autoload
  name: '@yankeguo/dsh-xcode-mcp'
  config:
    serverName: xcode
    command: xcrun
    args:
      - mcpbridge
    env: {}
    startupTimeoutMs: 30000
```

## Requirements

- macOS with Xcode 26 or newer (`xcrun --find mcpbridge` must succeed), and Xcode running while the Session uses the tools.
- DSH `>=0.2.1-rc.1 <0.3.0` (API surface checked against tags `dsh-v0.2.1-rc.1` and `dsh-v0.2.2-rc.5`; runtime baseline `0.2.2-rc.5`).

## Installation

```sh
# CLI (desktop profile)
dsh plugin --profile desktop add @yankeguo/dsh-xcode-mcp

# or in the Web UI: Plugins → Add plugin → @yankeguo/dsh-xcode-mcp
```

For local development, install this checkout as a linked bundle through DSH's plugin manager (`install_bundle` pointed at this directory); run `pnpm build` first so `lib/index.js` exists, and rebuild after source changes.

## Troubleshooting

- **No `mcp__xcode__*` tools in an Xcode project.** Check the Host log for `xcode-mcp-autoload` diagnostics. `cannot find mcpbridge` means Xcode 26+ is not installed or `xcode-select` points elsewhere; fix with `sudo xcode-select -s /Applications/Xcode.app`. Discovery stops at the `.git` root: a project outside the Session's repository is intentionally not mounted.
- **Xcode authorization gate.** On the first MCP connection, Xcode itself asks you to authorize the connecting client. Xcode must be running, and the approval must be granted in Xcode; until then tool calls fail or time out. If the prompt was dismissed, reconnect the Session (or restart Xcode) to trigger it again.
- **Tools time out.** The initial connection plus tool sync is bounded by `startupTimeoutMs` (default 30s); individual tool calls use the MCP client's `toolCallTimeoutMs` (default 60s). Large builds may need a longer tool-call timeout in a custom `mcp-client` setup.

## Verify

1. Install the bundle into the profile and enable it.
2. Open a **new** Session whose workspace (or an ancestor up to the `.git` root) contains a `*.xcodeproj`.
3. Call `mcp__xcode__*` tools — for example list available Xcode tools or run a build. The tools must be present only in that Session.
4. Open a new Session in a workspace without an Xcode project. It must have no `mcp__xcode__*` tools.
5. Disable the bundle or close the Agent and confirm the `mcpbridge` child process is gone.

## Development

```sh
pnpm install
pnpm verify   # typecheck + unit tests + build
```

The build emits `lib/index.js`, which the bundle manifest exports. Publishing uses the staged model (CI stages, a maintainer approves with 2FA, then the GitHub Release is created); see [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Layout

```
src/index.ts        project discovery, bridge probe, MCP mount, Agent lifecycle
tests/              discovery, configuration, lifecycle unit tests
cordis.patch.yml    bundle row
locale/en.json      Plugin Manager metadata (English)
locale/zh.json      Plugin Manager metadata (Chinese)
icon.svg            bundle icon
scripts/            staged-publish tooling (stage / promote / trust / checks)
.github/workflows/  verify.yml (CI checks) and publish.yml (staged publishing)
docs/               publishing guide and release notes
```