/**
 * Mount the Xcode MCP server into Sessions that work inside an Xcode project.
 *
 * The plugin reads each live Agent's working directory, walks upward to the
 * nearest directory containing a `*.xcodeproj` directory, and connects one
 * `mcp-client` instance through that Agent's own Context. Tools therefore
 * appear only for that Agent (`mcp__xcode__*`) and the child process is
 * disconnected when the Agent is disposed.
 *
 * Discovery stops at the first ancestor carrying `.git` (after checking that
 * ancestor itself) or at the filesystem root, whichever comes first.
 *
 * @module @yankeguo/dsh-xcode-mcp
 */

import { readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used in loader diagnostics. */
export const name = 'xcode-mcp-autoload'

/** Services that must exist before the plugin activates. */
export const inject = ['agents', 'workingDirectory']

/** Default executable: the user's uv installation. */
const DEFAULT_COMMAND = '/Users/guoyk/.local/bin/uv'

/** Default launcher that execs `xcrun mcpbridge` inside an Xcode project. */
const DEFAULT_ARGS = ['run', '/Users/guoyk/Workspace/dsh/scripts/xcode-mcp.py']

/** Default environment for uv; the official PyPI index times out on this machine. */
const DEFAULT_ENV = { UV_DEFAULT_INDEX: 'https://pypi.tuna.tsinghua.edu.cn/simple' }

/** Default allowance for one connection attempt plus its initial tool sync. */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000

/** Marker directory that ends the upward walk. */
const REPOSITORY_MARKER = '.git'

/** Suffix of an Xcode project directory. */
const XCODE_PROJECT_SUFFIX = '.xcodeproj'

/** Settings for the Xcode MCP client, with defaults for this machine. */
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
   * Watchdog for the initial MCP connection and tool sync, in milliseconds.
   * The plugin's own timeout keeps compatibility with `mcp-client` releases
   * that predate `startupTimeoutMs`.
   */
  startupTimeoutMs: number
}

/** Validate and default the plugin configuration. */
export const Config: z<Partial<Config>, Config> = z.object({
  serverName: z.string().pattern(/^[A-Za-z0-9_-]{1,32}$/).default('xcode'),
  command: z.string().pattern(/\S/).default(DEFAULT_COMMAND),
  args: z.array(String).default([...DEFAULT_ARGS]),
  env: z.dict(String).default({ ...DEFAULT_ENV }),
  startupTimeoutMs: z.number().min(1).default(DEFAULT_STARTUP_TIMEOUT_MS),
})

/** Discovered project root and the project directory that identified it. */
export interface XcodeProjectLocation {
  /** Directory that becomes the MCP child process's working directory. */
  root: string
  /** Name of the `*.xcodeproj` directory inside `root`. */
  project: string
}

/** Test seam for the filesystem discovery and the MCP mount. */
export interface AutoloaderOptions {
  /** Replace the filesystem walk (defaults to {@link findXcodeProjectRoot}). */
  discoverProjectRoot?: (cwd: string) => Promise<XcodeProjectLocation | undefined>
  /** Replace the per-Agent mount (defaults to `agent.ctx.plugin(McpClient, …)`). */
  mount?: (agent: Agent, config: McpClient.Config) => Fiber & PromiseLike<Fiber>
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
  const mount = options.mount ?? ((agent: Agent, mountConfig: McpClient.Config) => agent.ctx.plugin(McpClient, mountConfig))
  const lifecycle = new AbortController()
  const seen = new WeakSet<Agent>()
  const fibers = new Set<Fiber>()
  const pending = new Set<Promise<void>>()

  const attach = (agent: Agent, signal?: AbortSignal): Promise<void> => {
    // One Agent has one lifecycle: a backfill and the creation event may race.
    if (seen.has(agent)) return Promise.resolve()
    seen.add(agent)
    const task = (async (): Promise<void> => {
      if (lifecycle.signal.aborted) return
      const scope = signal === undefined ? lifecycle.signal : AbortSignal.any([signal, lifecycle.signal])
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
      let mounted: (Fiber & PromiseLike<Fiber>) | undefined
      let release: (() => void) | undefined
      try {
        release = agent.ctx.effect(() => () => {
          if (mounted !== undefined) fibers.delete(mounted)
        }, 'xcode-mcp-autoload.attach')
        mounted = mount(agent, createMountConfig(config, location.root))
        fibers.add(mounted)
        await withTimeout(mounted, config.startupTimeoutMs, `xcode-mcp-autoload: MCP startup timed out for agent ${agent.id}`)
        ctx.logger.info(`xcode-mcp-autoload: mounted ${config.serverName} MCP server for agent ${agent.id} at ${location.root}`)
      } catch (error) {
        release?.()
        if (mounted !== undefined) {
          fibers.delete(mounted)
          await mounted.dispose()
        }
        if (!scope.aborted) ctx.logger.warn(`xcode-mcp-autoload: cannot mount the Xcode MCP server for agent ${agent.id}`, error)
      }
    })()
    pending.add(task)
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    )
    return task
  }

  ctx.effect(() => async () => {
    lifecycle.abort()
    // Dispose synchronously known fibers first so an in-flight startup is
    // interrupted instead of delaying plugin unload until the watchdog fires.
    await Promise.allSettled([...fibers].map(fiber => fiber.dispose()))
    await Promise.allSettled([...pending])
    await Promise.allSettled([...fibers].map(fiber => fiber.dispose()))
  }, 'xcode-mcp-autoload.lifecycle')

  ctx.on('agent/created', async ({ agent, signal }) => {
    await attach(agent, signal)
    return undefined
  })
  for (const agent of ctx.agents.list()) await attach(agent)
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

/** Lexicographically first `*.xcodeproj` directory inside one directory, if any. */
async function firstXcodeProject(directory: string): Promise<string | undefined> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return undefined
  }
  return entries
    .filter(entry => entry.isDirectory() && entry.name.endsWith(XCODE_PROJECT_SUFFIX))
    .map(entry => entry.name)
    .sort()[0]
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

/** Await one promise-like value with a watchdog. */
function withTimeout<T>(value: PromiseLike<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message))
    }, timeoutMs)
    value.then(
      (result) => {
        clearTimeout(timer)
        resolvePromise(result)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}