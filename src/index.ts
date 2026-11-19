/**
 * Mount the Xcode MCP server into Sessions that work inside an Xcode project.
 *
 * The plugin reads each live Agent's working directory, walks upward to the
 * nearest directory containing a `*.xcodeproj` directory, and connects one
 * `mcp-client` instance through that Agent's own Context, starting
 * `xcrun mcpbridge` (Xcode 26+) with the project root as its working
 * directory. Tools therefore appear only for that Agent (`mcp__xcode__*`)
 * and the child process is disconnected when the Agent is disposed.
 *
 * The same Agents also receive Xcode's official skills: the plugin exports
 * them once per activation with `xcrun agent skills export` into a stable
 * cache directory and registers a skill provider through each Agent's own
 * Context, so the skills are visible only to Xcode-workspace Agents.
 *
 * Discovery stops at the first ancestor carrying `.git` (after checking that
 * ancestor itself) or at the filesystem root, whichever comes first.
 *
 * @module @yankeguo/dsh-xcode-mcp
 */

import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillCandidate, SkillDefinition, SkillInvocationPolicy } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'
import { parse as parseYaml } from 'yaml'

/** Cordis plugin name used in loader diagnostics. */
export const name = 'xcode-mcp-autoload'

/** Services that must exist before the plugin activates. */
export const inject = ['agents', 'workingDirectory']

/** Default executable: macOS ships `xcrun` at /usr/bin/xcrun. */
const DEFAULT_COMMAND = 'xcrun'

/** Default arguments: Xcode 26+ exposes its MCP server through `mcpbridge`. */
const DEFAULT_ARGS = ['mcpbridge']

/** Default environment: none; `mcpbridge` needs no extra variables. */
const DEFAULT_ENV: Record<string, string> = {}

/** Upper bound for the `xcrun --find mcpbridge` availability probe. */
const PROBE_TIMEOUT_MS = 10_000

/** Upper bound for one `xcrun agent skills export` run. */
const EXPORT_TIMEOUT_MS = 60_000

/** Precedence of exported Xcode skills: packaged content, below user roots. */
const XCODE_SKILL_RANK = 600

/** Provider name registered on `ctx.skills` in each Xcode Agent's layer. */
const SKILL_PROVIDER_NAME = 'xcode'

/** Kebab-case skill name grammar shared with the skill registry. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Default allowance for one connection attempt plus its initial tool sync. */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000

/**
 * Largest delay Node's `setTimeout` accepts; bigger values overflow and fire
 * immediately, which would turn a generous watchdog into an instant failure.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Marker directory that ends the upward walk. */
const REPOSITORY_MARKER = '.git'

/** Suffix of an Xcode project directory. */
const XCODE_PROJECT_SUFFIX = '.xcodeproj'

/** Settings for the Xcode MCP client. */
export interface Config {
  /** Model-facing MCP namespace; tools appear as `mcp__<serverName>__*`. */
  serverName: string
  /** Executable used to start the MCP server. */
  command: string
  /** Arguments passed to `command` without shell interpolation. */
  args: string[]
  /** Extra environment variables merged over the scrubbed ambient environment. */
  env: Record<string, string>
  /**
   * Watchdog for the initial MCP connection and tool sync, in integer
   * milliseconds (1 to 2147483647, Node's maximum timer delay). The plugin's
   * own timeout keeps compatibility with `mcp-client` releases that predate
   * `startupTimeoutMs`.
   */
  startupTimeoutMs: number
  /**
   * Export Xcode's official skills once per activation and register them for
   * Xcode-workspace Agents. Requires the `skills` service for registration;
   * without it the export still runs (and refreshes the cache), while the
   * provider stays pending and the MCP mount works unchanged.
   */
  skills: boolean
}

/** Validate and default the plugin configuration. */
export const Config: z<Partial<Config>, Config> = z.object({
  serverName: z.string().pattern(/^[A-Za-z0-9_-]{1,32}$/).default('xcode'),
  command: z.string().pattern(/\S/).default(DEFAULT_COMMAND),
  args: z.array(String).default([...DEFAULT_ARGS]),
  env: z.dict(String).default({ ...DEFAULT_ENV }),
  // `.step(1)` also rejects `NaN`, which range checks alone let through: a
  // `startupTimeoutMs: .nan` profile row would otherwise turn the watchdog
  // into an immediate timeout for every mount.
  startupTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STARTUP_TIMEOUT_MS),
  skills: z.boolean().default(true),
})

/** Discovered project root and the project directory that identified it. */
export interface XcodeProjectLocation {
  /** Directory that becomes the MCP child process's working directory. */
  root: string
  /** Name of the `*.xcodeproj` directory inside `root`. */
  project: string
}

/** Test seam for the filesystem discovery, the bridge probe, and the MCP mount. */
export interface AutoloaderOptions {
  /** Replace the filesystem walk (defaults to {@link findXcodeProjectRoot}). */
  discoverProjectRoot?: (cwd: string) => Promise<XcodeProjectLocation | undefined>
  /** Replace the `mcpbridge` availability probe (defaults to {@link probeMcpBridge}). */
  probeBridge?: (command: string, args: string[], env?: Record<string, string>) => Promise<boolean>
  /** Replace the per-Agent mount (defaults to `agent.ctx.plugin(McpClient, …)`). */
  mount?: (agent: Agent, config: McpClient.Config) => Fiber & PromiseLike<Fiber>
  /** Replace the skills export (defaults to {@link exportXcodeSkills}). */
  exportSkills?: (cacheDir: string, signal: AbortSignal, options?: XcodeLauncherOptions) => Promise<void>
  /** Override the skills cache directory (defaults to {@link defaultSkillsCacheDir}). */
  skillsCacheDir?: string
}

/**
 * Find the closest directory containing an Xcode project directory.
 * @param start - working directory to inspect first, resolved to an absolute path.
 * @returns the nearest project root and the lexicographically first project in
 *   it, or `undefined` when no ancestor up to the `.git` root or filesystem
 *   root contains one.
 */
export async function findXcodeProjectRoot(start: string): Promise<XcodeProjectLocation | undefined> {
  let current = resolve(start)
  for (;;) {
    const project = await firstXcodeProject(current)
    if (project !== undefined) return { root: current, project }
    if (await exists(join(current, REPOSITORY_MARKER))) return undefined
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Build the resolved MCP client configuration for one project root.
 * @param config - plugin configuration.
 * @param cwd - project root used as the child process's working directory.
 * @returns a validated `mcp-client` stdio configuration.
 */
export function createMountConfig(config: Config, cwd: string): McpClient.Config {
  return McpClient.Config({
    transport: 'stdio',
    serverName: config.serverName,
    command: config.command,
    args: config.args,
    env: config.env,
    cwd,
    // A missing Xcode, disabled mcpbridge, or broken launcher must not fail
    // Agent creation; the client logs the failure and keeps the Session usable.
    failOnStartupError: false,
  })
}

/**
 * Mount the Xcode server for existing Agents and every Agent created later.
 * @param ctx - plugin Context providing the Agent registry and working directories.
 * @param config - resolved plugin configuration.
 * @param options - test seams for discovery and mounting.
 * @returns fulfillment after the existing Agents have been inspected.
 */
export async function startAutoloader(
  ctx: Context,
  config: Config,
  options: AutoloaderOptions = {},
): Promise<void> {
  const discover = options.discoverProjectRoot ?? findXcodeProjectRoot
  const probe = options.probeBridge ?? probeMcpBridge
  const mount = options.mount ?? ((agent: Agent, mountConfig: McpClient.Config) => agent.ctx.plugin(McpClient, mountConfig))
  const exportSkills = options.exportSkills ?? exportXcodeSkills
  const skillsCacheDir = options.skillsCacheDir ?? defaultSkillsCacheDir()
  // The skills export must use the same Xcode the MCP mount will use. A custom
  // `xcrun` path is reused when it is still xcrun; otherwise the system xcrun
  // is the only meaningful exporter, with the configured env (e.g.
  // DEVELOPER_DIR) applied to both.
  const skillsCommand = basename(config.command) === 'xcrun' ? config.command : DEFAULT_COMMAND
  const lifecycle = new AbortController()
  const tasks = new WeakMap<Agent, { task: Promise<void>; controller: AbortController }>()
  const fibers = new Set<Fiber>()
  const pending = new Set<Promise<void>>()
  // Registration-scoped invalidators of every live per-Agent skill provider;
  // the export task fans out to them when a fresh export lands.
  const invalidators = new Set<() => void>()

  const attach = (agent: Agent, signal?: AbortSignal): Promise<void> => {
    // One Agent has one lifecycle: a backfill and the creation event may race.
    // Reuse the in-flight task instead of resolving immediately, so a serial
    // `agent/created` listener still waits for the mount before creation
    // settles.
    const existing = tasks.get(agent)
    if (existing !== undefined) {
      // The shared backfill task predates this creation signal. Link the
      // signal to the task's own controller so cancellation stops the mount
      // too, not only this listener's wait.
      if (signal === undefined) return existing.task
      const unlink = linkAbort(existing.controller, signal)
      return settleOnAbort(existing.task, signal).finally(unlink)
    }
    const controller = new AbortController()
    const task = (async (): Promise<void> => {
      if (lifecycle.signal.aborted) return
      const scope = AbortSignal.any([
        controller.signal,
        lifecycle.signal,
        ...(signal === undefined ? [] : [signal]),
      ])
      let cwd: string
      try {
        cwd = await ctx.workingDirectory.ensure(agent, scope)
      } catch (error) {
        if (!scope.aborted) ctx.logger.warn(`xcode-mcp-autoload: cannot resolve the working directory of agent ${agent.id}`, error)
        return
      }
      if (scope.aborted) return
      let location: XcodeProjectLocation | undefined
      try {
        location = await discover(cwd)
      } catch (error) {
        if (!scope.aborted) ctx.logger.warn(`xcode-mcp-autoload: cannot inspect ${JSON.stringify(cwd)} for an Xcode project`, error)
        return
      }
      if (location === undefined || scope.aborted) return
      // Fail fast with a clear diagnostic when the default bridge is missing,
      // instead of letting the MCP client log connection failures and retries.
      let available: boolean
      try {
        available = await probe(config.command, config.args, config.env)
      } catch (error) {
        if (!scope.aborted) ctx.logger.warn(`xcode-mcp-autoload: cannot probe ${config.command} for agent ${agent.id}`, error)
        return
      }
      if (scope.aborted) return
      if (!available) {
        ctx.logger.warn(`xcode-mcp-autoload: ${config.command} cannot find mcpbridge (requires Xcode 26+ with xcode-select pointing at it); skipping the Xcode MCP mount for agent ${agent.id}`)
        return
      }
      if (scope.aborted) return
      // Skills are independent of the MCP connection: register them even when
      // the later mount fails. The child plugin injects `skills`, so a profile
      // without the skill registry simply leaves it pending — the MCP feature
      // and Agent creation are unaffected.
      if (config.skills) {
        let skillsFiber: (Fiber & PromiseLike<Fiber>) | undefined
        let releaseSkills: (() => void) | undefined
        try {
          releaseSkills = agent.ctx.effect(() => () => {
            if (skillsFiber !== undefined) fibers.delete(skillsFiber)
          }, 'xcode-mcp-autoload.skills')
          skillsFiber = agent.ctx.plugin(xcodeSkillsProvider, { cacheDir: skillsCacheDir, invalidators })
          fibers.add(skillsFiber)
          // The child plugin's apply is asynchronous: a provider-registration
          // failure (for example a duplicate provider name in this Agent's
          // scope) must still produce a plugin diagnostic instead of only a
          // Cordis error. MCP mounting continues independently.
          void Promise.resolve(skillsFiber).catch((error: unknown) => {
            if (!scope.aborted) {
              ctx.logger.warn(`xcode-mcp-autoload: cannot register Xcode skills for agent ${agent.id}`, error)
            }
          })
        } catch (error) {
          releaseSkills?.()
          if (skillsFiber !== undefined) {
            fibers.delete(skillsFiber)
            try {
              await skillsFiber.dispose()
            } catch (cleanupError) {
              ctx.logger.warn(`xcode-mcp-autoload: cannot dispose the failed skills provider for agent ${agent.id}`, cleanupError)
            }
          }
          if (!scope.aborted) ctx.logger.warn(`xcode-mcp-autoload: cannot register Xcode skills for agent ${agent.id}`, error)
        }
      }
      if (scope.aborted) return
      let mounted: (Fiber & PromiseLike<Fiber>) | undefined
      let release: (() => void) | undefined
      try {
        release = agent.ctx.effect(() => () => {
          if (mounted !== undefined) fibers.delete(mounted)
        }, 'xcode-mcp-autoload.attach')
        mounted = mount(agent, createMountConfig(config, location.root))
        fibers.add(mounted)
        await withTimeout(
          mounted,
          config.startupTimeoutMs,
          `xcode-mcp-autoload: MCP startup timed out for agent ${agent.id}`,
          scope,
        )
        ctx.logger.info(`xcode-mcp-autoload: registered ${config.serverName} MCP client for agent ${agent.id} at ${location.root}`)
      } catch (error) {
        release?.()
        if (mounted !== undefined) {
          fibers.delete(mounted)
          // A failing cleanup must not escape: this task backs the serial
          // `agent/created` listener, whose rejection would fail Agent
          // registration itself.
          try {
            await mounted.dispose()
          } catch (cleanupError) {
            ctx.logger.warn(`xcode-mcp-autoload: cannot dispose the failed MCP mount for agent ${agent.id}`, cleanupError)
          }
        }
        if (!scope.aborted) ctx.logger.warn(`xcode-mcp-autoload: cannot mount the Xcode MCP server for agent ${agent.id} at ${location.root}`, error)
      }
    })()
    tasks.set(agent, { task, controller })
    pending.add(task)
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    )
    return task
  }

  // One export per activation, concurrent with backfill and Agent creation:
  // providers read whatever the cache holds, and a completed export
  // invalidates every live provider so catalogs refresh without a restart.
  if (config.skills) {
    const exportTask = (async (): Promise<void> => {
      try {
        if (lifecycle.signal.aborted) return
        if (!await probe(skillsCommand, ['mcpbridge'], config.env)) {
          if (lifecycle.signal.aborted) return
          ctx.logger.info('xcode-mcp-autoload: mcpbridge is unavailable; skipping the Xcode skills export')
          return
        }
        if (lifecycle.signal.aborted) return
        await exportSkills(skillsCacheDir, lifecycle.signal, { command: skillsCommand, env: config.env })
        for (const invalidate of [...invalidators]) invalidate()
        ctx.logger.info(`xcode-mcp-autoload: exported Xcode skills to ${skillsCacheDir}`)
      } catch (error) {
        if (!lifecycle.signal.aborted) {
          ctx.logger.warn('xcode-mcp-autoload: cannot export Xcode skills; Xcode-workspace sessions keep any previously cached skills', error)
        }
      }
    })()
    pending.add(exportTask)
    void exportTask.then(
      () => pending.delete(exportTask),
      () => pending.delete(exportTask),
    )
  }

  // Cordis defers effect teardown until apply settles, so the lifecycle effect
  // below cannot interrupt a startup that is still in flight during the
  // initial backfill. This observer runs as soon as unload begins, aborts the
  // shared lifecycle, and lets the attach watchdog's abort race settle the
  // mount (and dispose it) without waiting for the full startup timeout.
  ctx.on('internal/plugin', (fiber) => {
    if (fiber !== ctx.fiber || fiber.uid !== null) return
    lifecycle.abort()
  }, { global: true })

  ctx.effect(() => async () => {
    lifecycle.abort()
    // Dispose synchronously known fibers first so an in-flight startup is
    // interrupted instead of delaying plugin unload until the watchdog fires.
    await Promise.allSettled([...fibers].map(fiber => fiber.dispose()))
    await Promise.allSettled([...pending])
    await Promise.allSettled([...fibers].map(fiber => fiber.dispose()))
  }, 'xcode-mcp-autoload.lifecycle')

  ctx.on('agent/created', async ({ agent, signal }) => {
    // `attach` contains its own failures, but this listener backs a serial
    // creation dispatch: keep the final boundary defensive so an unexpected
    // internal error can never fail Agent registration.
    try {
      await attach(agent, signal)
    } catch (error) {
      ctx.logger.warn(`xcode-mcp-autoload: unexpected attach failure for agent ${agent.id}`, error)
    }
    return undefined
  })
  // Inspect existing Agents concurrently: one slow startup must not delay the
  // others, and activation time is the slowest mount, not their sum.
  await Promise.allSettled(ctx.agents.list().map(agent => attach(agent)))
}

/**
 * Activate the autoloader for the Host's Agents.
 * @param ctx - plugin Context.
 * @param config - resolved plugin configuration.
 * @returns fulfillment after existing Agents have been inspected.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await startAutoloader(ctx, config)
}

/** Configuration of the per-Agent skills provider child plugin. */
interface SkillsProviderConfig {
  /** Directory holding the exported `<name>/SKILL.md` bundles. */
  cacheDir: string
  /** Shared invalidator registry owned by the autoloader instance. */
  invalidators: Set<() => void>
}

/**
 * Per-Agent skill provider for the exported Xcode skills.
 *
 * Mounted through `agent.ctx`, so the registration lands in that Agent's
 * scope layer and only that Agent's catalog sees the skills — the same
 * scoping the MCP tools use. Injecting `skills` keeps profiles without the
 * skill registry inert instead of failing the parent plugin.
 */
const xcodeSkillsProvider = {
  name: 'xcode-mcp-autoload.skills',
  inject: ['skills'],
  apply(ctx: Context, config: SkillsProviderConfig): void {
    let invalidate: (() => void) | undefined
    try {
      ctx.skills.registerProvider((control) => {
        invalidate = control.invalidate
        config.invalidators.add(control.invalidate)
        return {
          name: SKILL_PROVIDER_NAME,
          list: options => listExportedSkills(config.cacheDir, {
            signal: options.signal,
            warn: (message, error) => ctx.logger.warn(message, error),
          }),
          get: (candidate, options) => loadExportedSkill(candidate, options.signal, {
            warn: (message, error) => ctx.logger.warn(message, error),
          }),
        }
      })
      ctx.effect(() => () => {
        if (invalidate !== undefined) config.invalidators.delete(invalidate)
      }, 'xcode-mcp-autoload.skills.invalidate')
    } catch (error) {
      // registerProvider calls the factory before it inserts into the layer;
      // a duplicate name throws after the invalidator was registered, and the
      // cleanup effect may never have been installed. Do not leak a stale no-op.
      if (invalidate !== undefined) config.invalidators.delete(invalidate)
      throw error
    }
  },
}

/**
 * Stable cache directory for the exported Xcode skills.
 *
 * Mirrors DSH's own `resolveDshHome`: an empty or whitespace-only `$DSH_HOME`
 * is unset, `~`/`~/…` expands against the OS home, and a relative value is
 * resolved against the Host's launch directory.
 * @param env - environment mapping used to read `DSH_HOME` (defaults to `process.env`).
 * @returns `<dshHome>/cache/dsh-xcode-mcp/skills`.
 */
export function defaultSkillsCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['DSH_HOME']
  const dshHome = configured !== undefined && configured.trim().length > 0
    ? expandHomePath(configured)
    : join(homedir(), '.dsh')
  return join(resolve(dshHome), 'cache', 'dsh-xcode-mcp', 'skills')
}

/** Expand the `~` forms DSH's own home resolver accepts. */
function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Optional launcher context shared by the bridge probe and the skills export. */
export interface XcodeLauncherOptions {
  /** Executable used for the `xcrun` command (defaults to `xcrun`). */
  command?: string
  /** Extra environment variables merged over the Host environment. */
  env?: Record<string, string>
}

/**
 * Export Xcode's official skills into the cache directory.
 *
 * Runs `<xcrun> agent skills export --output-dir <cacheDir> --replace-existing`
 * so the cache always matches the locally installed Xcode. The content is
 * generated on the user's machine from their own Xcode; the package ships no
 * Apple content. Bounded by {@link EXPORT_TIMEOUT_MS} and the caller's signal.
 * @param cacheDir - directory receiving the skill subdirectories.
 * @param signal - cancellation; aborts and kills the export child process.
 * @param options - xcrun executable and extra environment shared with the MCP mount.
 */
export async function exportXcodeSkills(
  cacheDir: string,
  signal?: AbortSignal,
  options: XcodeLauncherOptions = {},
): Promise<void> {
  await mkdir(cacheDir, { recursive: true })
  const command = options.command ?? DEFAULT_COMMAND
  const env = options.env === undefined ? undefined : { ...process.env, ...options.env }
  await new Promise<void>((resolvePromise, reject) => {
    execFile(command, ['agent', 'skills', 'export', '--output-dir', cacheDir, '--replace-existing'], {
      timeout: EXPORT_TIMEOUT_MS,
      ...(env === undefined ? {} : { env }),
      ...(signal === undefined ? {} : { signal }),
    }, (error, _stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`${command} agent skills export failed: ${stderr.trim() || error.message}`, { cause: error }))
      } else {
        resolvePromise()
      }
    })
  })
}

/** One parsed `SKILL.md` bundle: catalog fields plus the instruction body. */
interface ParsedSkillBundle {
  name: string
  description: string
  whenToUse?: string
  metadata?: Readonly<Record<string, unknown>>
  invocation: SkillInvocationPolicy
  content: string
}

/**
 * List the exported skill bundles as registry candidates.
 *
 * A missing cache directory is a valid empty state (the export may still be
 * in flight or may have failed); a malformed bundle is skipped with a
 * diagnostic so its readable siblings stay available.
 * @param cacheDir - directory holding the exported `<name>/SKILL.md` bundles.
 * @param options - cancellation and an optional diagnostic sink.
 * @returns candidates at the packaged-content rank, sorted by directory name.
 */
export async function listExportedSkills(cacheDir: string, options: {
  signal?: AbortSignal | undefined
  warn?: (message: string, error?: unknown) => void
} = {}): Promise<SkillCandidate[]> {
  options.signal?.throwIfAborted()
  let entries
  try {
    entries = await readdir(cacheDir, { withFileTypes: true })
  } catch (error) {
    options.signal?.throwIfAborted()
    const code = (error as NodeJS.ErrnoException).code
    // A missing cache is the normal "export not landed yet" state; any other
    // readdir failure (permissions, a file in place of the directory) is a
    // real configuration problem worth surfacing.
    if (code !== 'ENOENT') {
      options.warn?.(`xcode-mcp-autoload: cannot list Xcode skills in ${cacheDir}`, error)
    }
    return []
  }
  const candidates: SkillCandidate[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const directory = join(cacheDir, entry.name)
    const path = join(directory, 'SKILL.md')
    try {
      const parsed = await readSkillBundle(path, options.signal)
      if (parsed === undefined) continue
      candidates.push({
        name: parsed.name,
        description: parsed.description,
        ...parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse },
        ...parsed.metadata === undefined ? {} : { metadata: parsed.metadata },
        invocation: parsed.invocation,
        source: 'bundled',
        provider: SKILL_PROVIDER_NAME,
        path,
        resourceBase: { kind: 'directory', path: directory },
        rank: XCODE_SKILL_RANK,
        locator: directory,
      })
    } catch (error) {
      options.signal?.throwIfAborted()
      options.warn?.(`xcode-mcp-autoload: skipping unreadable or malformed Xcode skill at ${path}`, error)
    }
  }
  return candidates
}

/**
 * Load one exported skill body, re-reading the current file on every call.
 * @param candidate - winning candidate originally returned by {@link listExportedSkills}.
 * @param signal - cancellation for the file read.
 * @param options - optional diagnostic sink for real read/permission failures.
 * @returns the complete definition, or `undefined` when the bundle disappeared,
 *   its name no longer matches the candidate, or a real read error occurred
 *   (the registry then rediscover / surfaces the skill as unavailable).
 */
export async function loadExportedSkill(
  candidate: SkillCandidate,
  signal?: AbortSignal,
  options: SkillLoadOptions = {},
): Promise<SkillDefinition | undefined> {
  const directory = typeof candidate.locator === 'string' ? candidate.locator : undefined
  if (directory === undefined) return undefined
  const path = join(directory, 'SKILL.md')
  let parsed: ParsedSkillBundle | undefined
  try {
    parsed = await readSkillBundle(path, signal)
  } catch (error) {
    // ENOENT/ENOTDIR come back as `undefined` from readSkillBundle. Anything
    // that reaches here is a real read problem (EACCES, EISDIR, ...): keep the
    // skill unavailable, but do not swallow the diagnostic.
    signal?.throwIfAborted()
    options.warn?.(`xcode-mcp-autoload: cannot load Xcode skill at ${path}`, error)
    return undefined
  }
  if (parsed === undefined || parsed.name !== candidate.name) return undefined
  return {
    ...candidate,
    invocation: parsed.invocation,
    content: parsed.content,
    ...parsed.metadata === undefined ? {} : { metadata: parsed.metadata },
  }
}

/** Optional diagnostic sink for one skill body load. */
export interface SkillLoadOptions {
  /** Receives real read errors; missing files are reported as `undefined`, not warned. */
  warn?: (message: string, error?: unknown) => void
}

/** Read and validate one `SKILL.md`; `undefined` when the file is absent. */
async function readSkillBundle(path: string, signal?: AbortSignal): Promise<ParsedSkillBundle | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // The bundle may disappear between readdir and read; a permission or
    // type error is a real problem and must reach the caller's diagnostic.
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
  signal?.throwIfAborted()
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (match === null) throw new Error('missing YAML frontmatter')
  const data: unknown = parseYaml(match[1] ?? '')
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('frontmatter is not a mapping')
  const record = data as Record<string, unknown>
  const name = record['name']
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) throw new Error('frontmatter name must be kebab-case')
  const description = record['description']
  if (typeof description !== 'string' || description.trim() === '') throw new Error('frontmatter description is required')
  // DSH's own SKILL.md convention spells this `whenToUse`, while Xcode's
  // `xcrun agent skills export` emits `when_to_use` (Xcode 27 verified); accept
  // both so Apple's routing guidance reaches the skill catalog.
  const whenToUse = record['whenToUse'] ?? record['when_to_use']
  if (whenToUse !== undefined && typeof whenToUse !== 'string') throw new Error('frontmatter whenToUse/when_to_use must be a string')
  const metadata = record['metadata']
  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
    throw new Error('frontmatter metadata must be a mapping')
  }
  const disableModel = record['disable-model-invocation']
  const userInvocable = record['user-invocable']
  if (disableModel !== undefined && typeof disableModel !== 'boolean') throw new Error('disable-model-invocation must be a boolean')
  if (userInvocable !== undefined && typeof userInvocable !== 'boolean') throw new Error('user-invocable must be a boolean')
  return {
    name,
    description,
    ...whenToUse === undefined ? {} : { whenToUse },
    ...metadata === undefined ? {} : { metadata: metadata as Readonly<Record<string, unknown>> },
    invocation: {
      modelInvocable: disableModel !== true,
      userInvocable: userInvocable !== false,
    },
    content: text.slice(match[0].length),
  }
}

/**
 * Whether the configured launcher can reach Xcode's MCP bridge.
 *
 * Only the default `xcrun mcpbridge` launcher is probed (`xcrun --find
 * mcpbridge`, bounded by {@link PROBE_TIMEOUT_MS}); a custom command/args pair
 * is trusted as configured and left for the MCP client to validate. A failed
 * probe skips the mount with a diagnostic instead of producing connection
 * failure noise; it never fails Agent creation.
 * @param command - configured executable.
 * @param args - configured arguments.
 * @param env - extra environment merged over the Host environment, so an
 *   explicit `DEVELOPER_DIR` selects the same Xcode the MCP client will use.
 * @returns `true` when the bridge is available or no probe applies.
 */
export async function probeMcpBridge(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<boolean> {
  if (basename(command) !== 'xcrun' || args[0] !== 'mcpbridge') return true
  return new Promise<boolean>((resolvePromise) => {
    execFile(command, ['--find', 'mcpbridge'], {
      timeout: PROBE_TIMEOUT_MS,
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    }, (error) => {
      resolvePromise(error === null)
    })
  })
}

/**
 * Lexicographically first `*.xcodeproj` directory inside one directory, if any.
 * Symlinked project directories count as directories (the link target is
 * stat-ed); unreadable directories are treated as project-less.
 */
async function firstXcodeProject(directory: string): Promise<string | undefined> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return undefined
  }
  const candidates = entries
    .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.endsWith(XCODE_PROJECT_SUFFIX))
    .map(entry => entry.name)
    .sort()
  for (const name of candidates) {
    if (await isDirectory(join(directory, name))) return name
  }
  return undefined
}

/** Whether a path resolves to a directory, following symbolic links. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Whether a path exists, regardless of its type. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Forward one caller cancellation signal to the shared attach controller.
 * @param controller - the attach task's own controller.
 * @param signal - creation cancellation signal of an event that joined the task.
 * @returns a cleanup function for the listener.
 */
function linkAbort(controller: AbortController, signal: AbortSignal): () => void {
  const onAbort = (): void => controller.abort(signal.reason)
  if (signal.aborted) {
    onAbort()
    return () => {}
  }
  signal.addEventListener('abort', onAbort, { once: true })
  return () => signal.removeEventListener('abort', onAbort)
}

/**
 * Await a task unless a cancellation signal fires first.
 *
 * Used for the shared backfill task: the task itself keeps its own lifecycle,
 * but a creation listener must not stay blocked on it after creation aborts.
 * @param task - in-flight attach task.
 * @param signal - creation cancellation signal.
 * @returns fulfillment when the task settles or the signal aborts.
 */
function settleOnAbort(task: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolvePromise) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      resolvePromise()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void task.then(
      () => {
        cleanup()
        resolvePromise()
      },
      () => {
        cleanup()
        resolvePromise()
      },
    )
  })
}

/**
 * Await one promise-like value with a watchdog and optional cancellation.
 *
 * The timer is unref'd so a pending mount can never keep the Host process
 * alive after everything else has stopped. An aborted `signal` rejects
 * immediately, which lets teardown dispose the underlying mount instead of
 * waiting for the full startup timeout.
 * @param value - the mount's activation promise.
 * @param timeoutMs - watchdog budget in milliseconds.
 * @param message - rejection message for the timeout and cancellation paths.
 * @param signal - optional cancellation shared with the attach task.
 */
function withTimeout<T>(
  value: PromiseLike<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      settle()
    }
    const onAbort = (): void => {
      finish(() => reject(new Error(message)))
    }
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      finish(() => reject(new Error(message)))
    }, timeoutMs)
    timer.unref()
    value.then(
      (result) => {
        finish(() => resolvePromise(result))
      },
      (error: unknown) => {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      },
    )
  })
}