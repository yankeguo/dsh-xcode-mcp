# dsh-xcode-mcp

Mount the Xcode MCP server and Xcode's official skills into DeepSeek Harness (DSH) Sessions that work inside an Xcode project.

`@yankeguo/dsh-xcode-mcp` is a DSH bundle plugin. For a Session created inside an Xcode project it starts `xcrun mcpbridge` for that Session, exposes Xcode's `mcp__xcode__*` tools, and serves the official Xcode skills exported from your own Xcode installation. Sessions outside an Xcode project are left untouched — no Xcode tools, no Xcode skills, no placeholder server.

- **Scoped to Xcode Sessions.** Only Sessions whose working directory is inside an Xcode project get Xcode tools and skills.
- **Includes Xcode's official skills.** SwiftUI, App Intents, device interaction, xctrace and more are exported from your installed Xcode; the package itself ships no Apple content.
- **No extra runtime.** Pure TypeScript: no Python, no `uv`, no launcher scripts. The only runtime dependency is a YAML parser.
- **Nothing to configure** in the common case: install it, open a Session inside your project, approve Xcode's prompt once.

## Requirements

- **macOS.** This bundle declares `darwin` only.
- **Xcode 26 or newer, installed and running.** `xcrun --find mcpbridge` must print a path. If `xcode-select` points at the Command Line Tools instead, select Xcode: `sudo xcode-select -s /Applications/Xcode.app`.
- **Xcode authorization.** Xcode authorizes clients per Session: the first Xcode call in each new Session must be `XcodeOpenWorkspace`, and you must approve the prompt in Xcode (see [First use](#first-use)).
- **DeepSeek Harness `>=0.2.1-rc.1 <0.3.0`.** Node.js `>=24.9` is required by the package `engines` (normally provided by the DSH installation).
- **Local only.** The plugin runs `xcrun` as a child process; no credentials, no network services of its own.

Exact compatibility notes and tested combinations: [docs/COMPATIBILITY.md](https://github.com/yankeguo/dsh-xcode-mcp/blob/main/docs/COMPATIBILITY.md).

## Installation

```sh
# CLI, desktop profile
dsh plugin --profile desktop add @yankeguo/dsh-xcode-mcp
```

Or in the Web UI: **Plugins → Add plugin** → `@yankeguo/dsh-xcode-mcp`. If the plugin manager lists the bundle as disabled, enable it.

Append `@<version>` to pin a version. Release notes are kept in [docs/releases](https://github.com/yankeguo/dsh-xcode-mcp/tree/main/docs/releases) and on [GitHub Releases](https://github.com/yankeguo/dsh-xcode-mcp/releases).

## First use

1. Open a **new** Session whose working directory is inside an Xcode project (or in a parent directory up to the repository root that contains a `*.xcodeproj`). The plugin decides when the Session's Agent is created; a Session that is later moved into a project is not re-scanned, so open a new Session instead.
2. Call `mcp__xcode__XcodeOpenWorkspace` with the absolute path of the project's `.xcodeproj` (or `.xcworkspace`). Connecting the MCP server is not enough: this call is what binds a project and makes Xcode show its authorization prompt.
3. Approve the prompt in Xcode. Until then, the other Xcode tools answer `This agent isn't approved to use Xcode's tools yet`.
4. Use the other `mcp__xcode__*` tools — for example `XcodeListSchemes` or `BuildProject` — and load the bundled Xcode skills (for example `swiftui-specialist`) with the `skill` tool.

Approval is per Session: every new Session needs its own `XcodeOpenWorkspace` call and approval. Sessions outside an Xcode project get no Xcode tools and no Xcode skills.

## Configuration

In the common case there is nothing to configure. The defaults are:

| Field | Default | Description |
| --- | --- | --- |
| `serverName` | `xcode` | Tool namespace, as in `mcp__xcode__*` |
| `command` | `xcrun` | Launcher executable |
| `args` | `["mcpbridge"]` | Launcher arguments |
| `env` | `{}` | Extra environment variables for the launcher |
| `startupTimeoutMs` | `30000` | Initial connection + tool-sync timeout, integer milliseconds (1–2147483647) |
| `skills` | `true` | Export Xcode's official skills and serve them to Xcode Sessions |

Override any field in the bundle row's `config` in your DSH profile patch:

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
    skills: true
```

Common reasons to override:

- **Select a specific Xcode** (for example a beta): `env: { DEVELOPER_DIR: /Applications/Xcode-beta.app/Contents/Developer }`. The same environment is used for the MCP server and the skills export.
- **Use a custom launcher**: set `command` and `args`. A custom launcher is trusted as configured; only the default `xcrun mcpbridge` form is preflighted.
- **Disable the bundled skills**: `skills: false` keeps the MCP tools but exports and serves no skills.

### Xcode skills

When `skills` is enabled (the default), the plugin exports Xcode's official skills once per activation into `$DSH_HOME/cache/dsh-xcode-mcp/skills` (default `~/.dsh/cache/dsh-xcode-mcp/skills`) and offers them to Xcode Sessions only. Skill bodies are re-read from that cache, so a fresh export becomes visible without restarting DSH.

Exported skills take precedence over same-name project/user skills inside Xcode Sessions. If a project-local skill with the same name must win, set `skills: false`. A failed or skipped export is logged, and the previously cached skills stay usable.

## How it works

- Xcode's MCP server is mounted per DSH Agent. Subagents have their own Agent and therefore their own `mcpbridge` process.
- Discovery walks upward from the Session's working directory to the nearest ancestor containing a `*.xcodeproj` directory, checks the `.git` root itself, and then stops; a project above the repository root is intentionally not mounted. If one directory contains several projects, the lexicographically first name is used.
- The decision is made when the Agent is created. Moving an existing Session to another directory does not re-evaluate the mount.
- Disabling the plugin (or closing the Agent) closes its `mcpbridge` child process and removes its skills.
- The only filesystem write is the skills cache above; project files are never modified.
- A missing Xcode, a failed skills export, or an MCP startup error is logged and never blocks Session creation.

Implementation details and the exact lifecycle: [docs/DESIGN.md](https://github.com/yankeguo/dsh-xcode-mcp/blob/main/docs/DESIGN.md).

## Limitations

- macOS only; Xcode 26+ must be installed and running while you use the tools.
- Only directories named `*.xcodeproj` identify a project. A repository that has an `.xcworkspace` but no `*.xcodeproj` directory is not detected.
- The mount is decided at Session creation: a Session moved into a project afterwards keeps its previous state until it is recreated.
- Xcode approval is per Session; every new Session needs a fresh `XcodeOpenWorkspace` call.
- Individual tool calls use the MCP client's `toolCallTimeoutMs` (default 60s). This plugin does not expose that setting; very long builds may need a custom `mcp-client` setup.
- The plugin adds no per-project files and no Web UI; configuration lives entirely in your DSH profile patch.

## Troubleshooting and FAQ

### No `mcp__xcode__*` tools in an Xcode project

- Confirm the Session was created inside the project. Discovery stops at the `.git` root, so a project outside the Session's repository is not mounted.
- Check the DSH Host log for `xcode-mcp-autoload` diagnostics. `cannot find mcpbridge` means Xcode 26+ is missing or `xcode-select` points at the Command Line Tools; fix it with `sudo xcode-select -s /Applications/Xcode.app`.
- Sessions whose directory is not inside an Xcode project intentionally get no tools.

### The tools say the agent isn't approved to use Xcode

Call `mcp__xcode__XcodeOpenWorkspace` with the project path first; that call makes Xcode show the approval prompt. If the prompt was dismissed, call it again (or restart Xcode). Xcode must be running.

### A tool call times out

The initial connection plus tool sync is bounded by `startupTimeoutMs` (default 30s); individual calls use the MCP client's `toolCallTimeoutMs` (default 60s). Raise `startupTimeoutMs` for a slow project filesystem; for long builds, use a custom `mcp-client` setup with a larger tool-call timeout.

### Xcode skills are missing

- Skills are only offered to Sessions created inside an Xcode project.
- `skills: false` disables them.
- Check the Host log: a failed or skipped export is logged once and the previous cache stays in use.
- A profile without DSH's skills service keeps the MCP tools working but cannot register the skills.

### Does the plugin modify my project or send data anywhere?

No. It starts local `xcrun` processes and its only write is the skills cache under `$DSH_HOME`; project files are untouched and the plugin makes no network requests of its own.

### Which Xcode does it use?

The Xcode selected by the launcher's `xcrun` (and `DEVELOPER_DIR` if set in `env`). When `command` is another `xcrun` path, the skills export reuses it; with a different custom launcher the export falls back to the system `xcrun`.

### Does it work on Linux or Windows?

No. The bundle requires macOS and Xcode.

## Documentation

- [Design and lifecycle](https://github.com/yankeguo/dsh-xcode-mcp/blob/main/docs/DESIGN.md)
- [Compatibility notes](https://github.com/yankeguo/dsh-xcode-mcp/blob/main/docs/COMPATIBILITY.md)
- [Development and contributing](https://github.com/yankeguo/dsh-xcode-mcp/blob/main/docs/CONTRIBUTING.md)
- [Publishing guide](https://github.com/yankeguo/dsh-xcode-mcp/blob/main/docs/PUBLISHING.md)
- [Audit records](https://github.com/yankeguo/dsh-xcode-mcp/blob/main/docs/AUDIT.md)
- [Release notes](https://github.com/yankeguo/dsh-xcode-mcp/tree/main/docs/releases)
- [GitHub Releases](https://github.com/yankeguo/dsh-xcode-mcp/releases)

## License

MIT — see [LICENSE](https://github.com/yankeguo/dsh-xcode-mcp/blob/main/LICENSE).
