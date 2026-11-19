# dsh-xcode-mcp

A minimal DeepSeek Harness (DSH) bundle that mounts the Xcode MCP server **only** in Sessions that work inside an Xcode project.

DSH has no workspace-level MCP configuration: a profile-level `mcp-client` entry starts one server with a fixed working directory. This bundle closes that gap natively. It watches the live Agent registry, reads each Agent's working directory, finds the nearest ancestor containing a `*.xcodeproj` directory, and loads one `mcp-client` instance through that Agent's own Context. The resulting `mcp__xcode__*` tools are visible only to that Agent, and the child process is disconnected when the Agent is disposed.

## Behavior

- **Per Agent, at creation.** Existing Agents are backfilled when the plugin activates; every later `agent/created` event is handled. Subagents get their own Agent and therefore their own MCP process.
- **Discovery.** Starting at the Session's current working directory, walk upward and return the first directory that contains a directory named `*.xcodeproj`. The walk checks the `.git` root itself and then stops; it also stops at the filesystem root. If several projects share one directory, the lexicographically first name is used.
- **No project, no mount.** Sessions outside an Xcode project get no Xcode tools and no placeholder server.
- **No writes.** The plugin has no manifest file, no Web UI, and performs no filesystem writes.
- **Clean teardown.** Disposing the Agent or disabling the bundle disposes the corresponding `mcp-client` fiber, which closes the stdio transport.
- **Failure isolation.** A missing working directory, unreadable project tree, or MCP startup failure is logged and never fails Agent creation.
- **Creation-time decision.** Discovery runs once when the Agent is created. Moving an existing Session to another directory (`workingDirectory.set`) does not re-evaluate the mount in this version.

## Defaults

| Field | Value |
| --- | --- |
| `serverName` | `xcode` |
| `command` | `/Users/guoyk/.local/bin/uv` |
| `args` | `["run", "/Users/guoyk/Workspace/dsh/scripts/xcode-mcp.py"]` |
| `env` | `{ "UV_DEFAULT_INDEX": "https://pypi.tuna.tsinghua.edu.cn/simple" }` |
| `startupTimeoutMs` | `30000` |

The launcher execs `xcrun mcpbridge` when its cwd contains a `*.xcodeproj` (Xcode 26+), and this bundle only mounts it from such a cwd. Every field is overridable through the bundle row's `config` in the profile patch:

```yaml
- id: xcode-mcp-autoload
  name: '@yankeguo/dsh-xcode-mcp'
  config:
    serverName: xcode
    command: /Users/you/.local/bin/uv
    args:
      - run
      - /path/to/xcode-mcp.py
    env:
      UV_DEFAULT_INDEX: https://pypi.tuna.tsinghua.edu.cn/simple
```

## Requirements

- DSH `>=0.2.1-rc.1 <0.3.0` (checked against tags `dsh-v0.2.1-rc.1` through `dsh-v0.2.2-rc.5`; runtime baseline `0.2.2-rc.5`).
- Xcode 26 or newer with `xcrun mcpbridge` available, and Xcode running while the Session uses the tools.
- The `uv` launcher above (or configure another command).

## Verify

1. Install the bundle into the profile and enable it.
2. Open a **new** Session whose workspace (or an ancestor up to the `.git` root) contains a `*.xcodeproj`.
3. Call `mcp__xcode__*` tools — for example list available Xcode tools or run a build. The tools must be present only in that Session.
4. Open a new Session in a workspace without an Xcode project. It must have no `mcp__xcode__*` tools.
5. Disable the bundle or close the Agent and confirm the `uv`/`mcpbridge` child process is gone.

## Development

```sh
pnpm install
pnpm verify   # typecheck + unit tests + build
```

The build emits `lib/index.js`, which the bundle manifest exports. Local installation is performed with DSH's plugin manager (`install_bundle` pointed at this directory); this repository is private and is not published to npm.

## Layout

```
src/index.ts        project discovery, MCP mount, Agent lifecycle
tests/              discovery, configuration, lifecycle unit tests
cordis.patch.yml    bundle row
locale/en.json      Plugin Manager metadata (English)
locale/zh.json      Plugin Manager metadata (Chinese)
icon.svg            bundle icon
```