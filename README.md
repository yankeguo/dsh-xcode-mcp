# dsh-xcode-mcp

A minimal DeepSeek Harness (DSH) bundle that mounts the Xcode MCP server **and Xcode's official skills** only in Sessions that work inside an Xcode project. Pure TypeScript — no Python, no `uv`, no extra runtime dependencies beyond a YAML parser.

DSH has no workspace-level MCP configuration: a profile-level `mcp-client` entry starts one server with a fixed working directory. This bundle closes that gap natively. It watches the live Agent registry, reads each Agent's working directory, finds the nearest ancestor containing a `*.xcodeproj` directory, and loads one `mcp-client` instance through that Agent's own Context, starting `xcrun mcpbridge` with the project root as its working directory. The resulting `mcp__xcode__*` tools are visible only to that Agent, and the child process is disconnected when the Agent is disposed. The same Agents also receive Xcode's official skills (SwiftUI, App Intents, device interaction, xctrace, …), exported from the locally installed Xcode at activation.

## Behavior

- **Per Agent, at creation.** Existing Agents are backfilled when the plugin activates (concurrently); every later `agent/created` event is handled. Subagents get their own Agent and therefore their own MCP process. Creating an Agent waits for that Agent's initial MCP handshake (bounded by `startupTimeoutMs`, default 30s), so its tools exist before the first turn; a hung Xcode cannot block creation past that bound.
- **Discovery.** Starting at the Session's current working directory, walk upward and return the first directory that contains a directory named `*.xcodeproj` (symlinked project directories count). The walk checks the `.git` root itself and then stops; it also stops at the filesystem root. If several projects share one directory, the lexicographically first name is used.
- **Embedded Xcode skills.** Once per activation the plugin runs `xcrun agent skills export --replace-existing` into its cache directory and registers a skill provider through each Xcode Agent's own Context. The skills appear only in Xcode-workspace Sessions, always match the locally installed Xcode, and refresh without a restart when a fresh export lands. See [Embedded Xcode skills](#embedded-xcode-skills).
- **No project, no mount.** At creation time, Sessions outside an Xcode project get no Xcode tools, no Xcode skills, and no placeholder server. (A Session moved out of its project later keeps its creation-time mount; see below.)
- **Bridge preflight.** With the default `xcrun mcpbridge` launcher, the plugin first runs `xcrun --find mcpbridge` (bounded by 10s). When the bridge is missing (no Xcode 26+, or `xcode-select` points at the Command Line Tools), the mount and the skills export are skipped with a clear diagnostic instead of MCP connection-failure noise. Custom `command`/`args` are trusted as configured and validated by the MCP client itself. `env` is applied to both the bridge and the skills export, so an explicit `DEVELOPER_DIR` selects one consistent Xcode.
- **First-use approval.** Xcode's MCP server does not bind a project from the process working directory alone. In each new Session, the first Xcode tool call must be `XcodeOpenWorkspace` with the project's `.xcodeproj` (or `.xcworkspace`) path; that call is what makes Xcode show its approval prompt. Until approval is granted, other Xcode tools return `This agent isn't approved to use Xcode's tools yet`.
- **Bounded writes.** The plugin has no manifest file and no Web UI; its only filesystem writes are the skills export into its own cache directory (see below).
- **Clean teardown.** Disposing the Agent or disabling the bundle disposes the corresponding `mcp-client` fiber and skill provider, which closes the stdio transport and removes the skills. An in-flight startup is aborted on unload, including during the initial backfill, instead of waiting for the watchdog.
- **Failure isolation.** A missing working directory, failed probe, failed skills export, or MCP startup failure is logged and never fails Agent creation — including when cleaning up a failed mount itself fails. An unreadable project directory is treated as project-less and the upward walk continues (fail-soft, no diagnostic). A failed export leaves the cache usable: bundles it did not replace remain available.
- **Creation-time decision.** Discovery and the mount run once when the Agent is created; a transient failure is not retried for that Agent (recreate the Session or re-enable the bundle). Moving an existing Session to another directory (`workingDirectory.set`) does not re-evaluate the mount in this version: the previous project's `mcp__xcode__*` tools and skills stay attached to that Agent, even if the new directory is outside an Xcode project, until the Agent is recreated.

## Defaults

| Field | Value |
| --- | --- |
| `serverName` | `xcode` |
| `command` | `xcrun` |
| `args` | `["mcpbridge"]` |
| `env` | `{}` |
| `startupTimeoutMs` | `30000` (integer milliseconds, 1–2147483647) |
| `skills` | `true` |

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
    skills: true
```

## Embedded Xcode skills

Installing the bundle is enough — no manual skill installation. Xcode 26 ships official skills (for example `swiftui-specialist`, `app-intents-specialist`, `device-interaction`, `xctrace`, `modernize-tests`, `audit-xcode-security-settings`); the plugin exports them with `xcrun agent skills export` and serves them through DSH's skill registry:

- **Export timing.** Once per plugin activation, asynchronously (it blocks neither activation nor Agent creation), into `$DSH_HOME/cache/dsh-xcode-mcp/skills` (default `~/.dsh/cache/dsh-xcode-mcp/skills`), with `--replace-existing` so the cache always matches the installed Xcode. The export is bounded by 60s and skipped when `mcpbridge` is unavailable. The package ships no Apple content: everything is generated locally from your own Xcode.
- **Scope.** The provider is registered through each Xcode Agent's own Context, so the skills are visible only to Sessions whose creation-time directory is inside an Xcode project — exactly like the `mcp__xcode__*` tools. Subagents get their own registration. Cold (not-yet-started) Session catalogs do not include them.
- **Precedence.** Exported skills sit at rank 600 (`BUNDLED_SKILL_RANK`) and win same-name packaged contributions inside their own layer. In DSH's default composition the filesystem project/user roots live in the global layer while this provider is registered in the Agent's layer, so nearest-layer-wins makes the exported Xcode skill shadow same-name global project/user skills inside Xcode Sessions, regardless of rank. Set `skills: false` if a project-local skill must win.
- **Freshness.** Skill bodies are re-read from the cache on every load; when a new export lands, registered providers are invalidated and the session catalog refreshes automatically.
- **Failure behavior.** A failed or timed-out export logs one diagnostic and leaves the cache usable: bundles the export did not replace remain available. A malformed or unreadable skill bundle is skipped with a diagnostic without hiding its siblings; a profile without the `skills` service keeps the MCP feature fully working (the provider stays pending).
- **Opt out.** Set `skills: false` in the bundle row's config.

## Requirements

- macOS with Xcode 26 or newer (`xcrun --find mcpbridge` must succeed), and Xcode running while the Session uses the tools.
- DSH `>=0.2.1-rc.1 <0.3.0` (API surface checked against tags `dsh-v0.2.1-rc.1` and `dsh-v0.2.2-rc.5`; runtime baseline `0.2.2-rc.5`).

## Installation

```sh
# CLI (desktop profile). After rc.2 approval, pin the exact release:
dsh plugin --profile desktop add @yankeguo/dsh-xcode-mcp@0.1.0-rc.2

# Unversioned install follows latest, which remains rc.1:
dsh plugin --profile desktop add @yankeguo/dsh-xcode-mcp

# or in the Web UI: Plugins → Add plugin → @yankeguo/dsh-xcode-mcp
```

> Current registry state (2026-11-19): there is no stable release yet. `latest`
> and `next` still point at `0.1.0-rc.1`; `0.1.0-rc.2` is the current
> audit-fix release candidate. The `v0.1.0-rc.2` tag workflow stages it with
> `next`; it becomes installable only after a successful stage and maintainer
> approval. `0.0.0-stage` is an earlier probe version. Pin the exact rc
> (`@0.1.0-rc.2` after approval, `@0.1.0-rc.1` until then); a maintainer should
> move `latest` to a stable version once one exists.

For local development, install this checkout as a linked bundle through DSH's plugin manager (`install_bundle` pointed at this directory); run `pnpm build` first so `lib/index.js` exists, and rebuild after source changes.

## Troubleshooting

- **No `mcp__xcode__*` tools in an Xcode project.** Check the Host log for `xcode-mcp-autoload` diagnostics. `cannot find mcpbridge` means Xcode 26+ is not installed or `xcode-select` points elsewhere; fix with `sudo xcode-select -s /Applications/Xcode.app`. Discovery stops at the `.git` root: a project outside the Session's repository is intentionally not mounted.
- **Xcode authorization gate.** Xcode does not authorize a client merely because it connected. In each new Session, call `mcp__xcode__XcodeOpenWorkspace` with the project path first; that call is what makes Xcode show the approval prompt. Grant it in Xcode. Until then other Xcode tools return `This agent isn't approved to use Xcode's tools yet`. If the prompt was dismissed, call `XcodeOpenWorkspace` again (or restart Xcode). Xcode must be running.
- **Tools time out.** The initial connection plus tool sync is bounded by `startupTimeoutMs` (default 30s); individual tool calls use the MCP client's `toolCallTimeoutMs` (default 60s). Large builds may need a longer tool-call timeout in a custom `mcp-client` setup.

## Verify

1. Install the bundle into the profile and enable it.
2. Open a **new** Session whose workspace (or an ancestor up to the `.git` root) contains a `*.xcodeproj`.
3. Call `mcp__xcode__XcodeOpenWorkspace` with the project path and approve the prompt in Xcode, then call other `mcp__xcode__*` tools — for example `XcodeListSchemes` or `BuildProject`. The tools must be present only in that Session. The session's skill catalog must also list the exported Xcode skills (for example `swiftui-specialist`), loadable with the `skill` tool.
4. Open a new Session in a workspace without an Xcode project. It must have no `mcp__xcode__*` tools and no Xcode skills.
5. Disable the bundle or close the Agent and confirm the `mcpbridge` child process is gone and the Xcode skills left the catalog.

## Development

```sh
pnpm install
pnpm verify   # typecheck + unit tests + build
```

The build emits `lib/index.js`, which the bundle manifest exports. Publishing uses the staged model (CI stages, a maintainer approves with 2FA, then the GitHub Release is created); see [docs/PUBLISHING.md](https://github.com/yankeguo/dsh-xcode-mcp/blob/main/docs/PUBLISHING.md).

## Layout

```
src/index.ts        project discovery, bridge probe, MCP mount, skills export/provider, Agent lifecycle
tests/              discovery, configuration, lifecycle, skills unit tests
cordis.patch.yml    bundle row
locale/en.json      Plugin Manager metadata (English)
locale/zh.json      Plugin Manager metadata (Chinese)
icon.svg            bundle icon
scripts/            staged-publish tooling (stage / promote / trust / checks)
.github/workflows/  verify.yml (CI checks) and publish.yml (staged publishing)
docs/               publishing guide, audit record, and release notes
```