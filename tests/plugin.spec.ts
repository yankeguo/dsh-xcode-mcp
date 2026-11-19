import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-working-directory'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, startAutoloader } from '../src/index.ts'
import type { XcodeLauncherOptions, XcodeProjectLocation } from '../src/index.ts'

const PROJECT_ROOT = '/tmp/Example'
const LOCATION: XcodeProjectLocation = { root: PROJECT_ROOT, project: 'Example.xcodeproj' }

interface AgentRig {
  agent: Agent
  holder: Fiber & PromiseLike<Fiber>
}

interface Harness {
  root: Context
  mounted: McpClient.Config[]
  disposals: string[]
  mount: (agent: Agent, config: McpClient.Config) => Fiber & PromiseLike<Fiber>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
})

function harness(options: {
  cwd?: string | Error
  agents?: Agent[]
} = {}): Harness {
  const root = new Context()
  cleanups.push(() => root.fiber.dispose())
  root.provide('workingDirectory', {
    ensure: async () => {
      if (options.cwd instanceof Error) throw options.cwd
      return options.cwd ?? PROJECT_ROOT
    },
  } as never)
  root.provide('agents', { list: () => options.agents ?? [] } as never)

  const mounted: McpClient.Config[] = []
  const disposals: string[] = []
  const stub = {
    name: 'stub-mcp-client',
    apply(stubCtx: Context, _config: McpClient.Config) {
      stubCtx.effect(() => () => {
        disposals.push('mcp-client')
      })
    },
  }
  return {
    root,
    mounted,
    disposals,
    mount(agent, config) {
      mounted.push(config)
      return agent.ctx.plugin(stub, config)
    },
  }
}

async function agentRig(root: Context, id: string): Promise<AgentRig> {
  let context: Context | undefined
  const holder = root.plugin({
    name: `test-agent-${id}`,
    apply(pluginCtx: Context) {
      context = pluginCtx
    },
  })
  await holder
  if (context === undefined) throw new Error('agent Context was not captured')
  return {
    agent: { id, ctx: context } as unknown as Agent,
    holder,
  }
}

function autoloader(
  harnessValue: Harness,
  options: {
    config?: Config
    discover?: () => Promise<XcodeProjectLocation | undefined>
    probe?: (command: string, args: string[], env?: Record<string, string>) => Promise<boolean>
    exportSkills?: (cacheDir: string, signal: AbortSignal, options?: XcodeLauncherOptions) => Promise<void>
    mount?: Harness['mount']
  } = {},
): Fiber & PromiseLike<Fiber> {
  return harnessValue.root.plugin({
    name: 'test-xcode-mcp-autoload',
    inject: ['workingDirectory', 'agents'],
    apply: (ctx: Context) => startAutoloader(ctx, options.config ?? Config({ skills: false }), {
      discoverProjectRoot: options.discover ?? (async () => LOCATION),
      // Tests must not depend on a real Xcode installation (CI has none).
      probeBridge: options.probe ?? (async () => true),
      ...(options.exportSkills === undefined ? {} : { exportSkills: options.exportSkills }),
      mount: options.mount ?? harnessValue.mount,
    }),
  })
}

describe('startAutoloader', () => {
  it('backfills a live Agent whose directory is inside an Xcode project', async () => {
    const agents: Agent[] = []
    const h = harness({ agents })
    const { agent } = await agentRig(h.root, 'agent-backfill')
    agents.push(agent)

    await autoloader(h)

    expect(h.mounted).toHaveLength(1)
    expect(h.mounted[0]).toMatchObject({
      transport: 'stdio',
      serverName: 'xcode',
      cwd: PROJECT_ROOT,
    })
  })

  it('passes config.env and a custom xcrun path to probe and skills export', async () => {
    const agents: Agent[] = []
    const h = harness({ agents })
    const { agent } = await agentRig(h.root, 'agent-toolchain')
    agents.push(agent)
    const env = { DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' }
    const probes: Array<{ command: string; args: string[]; env: Record<string, string> | undefined }> = []
    const exports: Array<XcodeLauncherOptions | undefined> = []

    await autoloader(h, {
      config: Config({ command: '/opt/tools/xcrun', args: ['mcpbridge'], env }),
      probe: async (command, args, seenEnv) => {
        probes.push({ command, args, env: seenEnv })
        return true
      },
      exportSkills: async (_cacheDir, _signal, options) => {
        exports.push(options)
      },
    })
    await vi.waitFor(() => expect(exports).toHaveLength(1))

    expect(probes).toHaveLength(2)
    for (const call of probes) {
      expect(call).toEqual({ command: '/opt/tools/xcrun', args: ['mcpbridge'], env })
    }
    expect(exports[0]).toEqual({ command: '/opt/tools/xcrun', env })
    expect(h.mounted).toHaveLength(1)
  })

  it('falls back to system xcrun for skills with a non-xcrun launcher', async () => {
    const agents: Agent[] = []
    const h = harness({ agents })
    const { agent } = await agentRig(h.root, 'agent-custom-launcher')
    agents.push(agent)
    const env = { DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' }
    const probes: Array<{ command: string; args: string[]; env: Record<string, string> | undefined }> = []
    const exports: Array<XcodeLauncherOptions | undefined> = []

    await autoloader(h, {
      config: Config({ command: '/bin/echo', args: ['serve'], env }),
      probe: async (command, args, seenEnv) => {
        probes.push({ command, args, env: seenEnv })
        return true
      },
      exportSkills: async (_cacheDir, _signal, options) => {
        exports.push(options)
      },
    })
    await vi.waitFor(() => expect(exports).toHaveLength(1))

    expect(probes).toContainEqual({ command: '/bin/echo', args: ['serve'], env })
    expect(probes).toContainEqual({ command: 'xcrun', args: ['mcpbridge'], env })
    expect(exports[0]).toEqual({ command: 'xcrun', env })
    expect(h.mounted).toHaveLength(1)
  })

  it('mounts when an Agent is created after activation', async () => {
    const h = harness()
    await autoloader(h)
    const { agent } = await agentRig(h.root, 'agent-created')

    await h.root.serial('agent/created', { agent, source: 'startup' })

    expect(h.mounted).toHaveLength(1)
    expect(h.mounted[0]).toMatchObject({ cwd: PROJECT_ROOT })
  })

  it('does not mount twice for a repeated creation event', async () => {
    const h = harness()
    await autoloader(h)
    const { agent } = await agentRig(h.root, 'agent-once')

    await h.root.serial('agent/created', { agent, source: 'startup' })
    await h.root.serial('agent/created', { agent, source: 'startup' })

    expect(h.mounted).toHaveLength(1)
  })

  it('does not mount twice when backfill and the creation event race', async () => {
    const agents: Agent[] = []
    const h = harness({ agents })
    const { agent } = await agentRig(h.root, 'agent-race')
    agents.push(agent)

    await autoloader(h)
    await h.root.serial('agent/created', { agent, source: 'startup' })

    expect(h.mounted).toHaveLength(1)
  })

  it('waits for an in-flight backfill mount before agent/created settles', async () => {
    const agents: Agent[] = []
    const h = harness({ agents })
    const { agent } = await agentRig(h.root, 'agent-backfill-race')
    agents.push(agent)
    let releaseDiscovery: (() => void) | undefined
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve })

    const fiber = autoloader(h, {
      discover: async () => {
        await discoveryGate
        return LOCATION
      },
    })
    try {
      // Let the plugin fiber run its apply far enough to register the
      // `agent/created` listener while the backfill discovery stays gated.
      await new Promise(resolve => setTimeout(resolve, 0))
      const creation = h.root.serial('agent/created', { agent, source: 'startup' })
      let settled = false
      void creation.then(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(settled).toBe(false)

      releaseDiscovery?.()
      await creation

      expect(h.mounted).toHaveLength(1)
    } finally {
      releaseDiscovery?.()
      await fiber.dispose()
    }
  })

  it('does not mount when no Xcode project is found', async () => {
    const h = harness()
    await autoloader(h, { discover: async () => undefined })
    const { agent } = await agentRig(h.root, 'agent-plain')

    await h.root.serial('agent/created', { agent, source: 'startup' })

    expect(h.mounted).toHaveLength(0)
  })

  it('keeps Agent creation working when the working directory cannot be resolved', async () => {
    const h = harness({ cwd: new Error('directory disappeared') })
    await autoloader(h)
    const { agent } = await agentRig(h.root, 'agent-unavailable')

    await expect(h.root.serial('agent/created', { agent, source: 'startup' })).resolves.toBeUndefined()
    expect(h.mounted).toHaveLength(0)
  })

  it('keeps Agent creation working when the MCP client cannot start', async () => {
    const h = harness()
    await autoloader(h, {
      mount: () => {
        throw new Error('spawn failed')
      },
    })
    const { agent } = await agentRig(h.root, 'agent-broken-mcp')

    await expect(h.root.serial('agent/created', { agent, source: 'startup' })).resolves.toBeUndefined()
  })

  it('keeps Agent creation working when cleaning up a failed mount also fails', async () => {
    const h = harness()
    let disposals = 0
    const broken = {
      then(_resolve: (value: Fiber) => void, reject: (error: Error) => void) {
        reject(new Error('startup failed'))
      },
      dispose: async () => {
        disposals += 1
        throw new Error('dispose failed')
      },
    } as unknown as Fiber & PromiseLike<Fiber>
    await autoloader(h, { mount: () => broken })
    const { agent } = await agentRig(h.root, 'agent-broken-cleanup')

    await expect(h.root.serial('agent/created', { agent, source: 'startup' })).resolves.toBeUndefined()
    expect(disposals).toBe(1)
  })

  it('does not wait forever for a hung MCP startup', async () => {
    const h = harness()
    let disconnects = 0
    const hung = {
      then() {},
      dispose: async () => {
        disconnects += 1
      },
    } as unknown as Fiber & PromiseLike<Fiber>
    await autoloader(h, {
      config: Config({ startupTimeoutMs: 20, skills: false }),
      mount: () => hung,
    })
    const { agent } = await agentRig(h.root, 'agent-hung')

    await expect(h.root.serial('agent/created', { agent, source: 'startup' })).resolves.toBeUndefined()

    expect(disconnects).toBe(1)
  })

  it('skips the mount with a diagnostic when mcpbridge is unavailable', async () => {
    const h = harness()
    await autoloader(h, { probe: async () => false })
    const { agent } = await agentRig(h.root, 'agent-no-bridge')

    await expect(h.root.serial('agent/created', { agent, source: 'startup' })).resolves.toBeUndefined()
    expect(h.mounted).toHaveLength(0)
  })

  it('keeps Agent creation working when the bridge probe itself fails', async () => {
    const h = harness()
    await autoloader(h, {
      probe: async () => {
        throw new Error('probe crashed')
      },
    })
    const { agent } = await agentRig(h.root, 'agent-broken-probe')

    await expect(h.root.serial('agent/created', { agent, source: 'startup' })).resolves.toBeUndefined()
    expect(h.mounted).toHaveLength(0)
  })

  it('interrupts an in-flight startup when the plugin is disposed', async () => {
    const h = harness()
    const fiber = autoloader(h, {
      config: Config({ startupTimeoutMs: 10_000, skills: false }),
      mount: () => {
        let rejectStartup: ((error: Error) => void) | undefined
        const inflight = {
          then(_resolve: (value: Fiber) => void, reject: (error: Error) => void) {
            rejectStartup = reject
          },
          dispose: async () => {
            // The real client rejects its startup promise when disposed.
            rejectStartup?.(new Error('disposed'))
          },
        } as unknown as Fiber & PromiseLike<Fiber>
        return inflight
      },
    })
    await fiber
    const { agent } = await agentRig(h.root, 'agent-inflight')
    // Creation-path mount: apply has settled, so the teardown effect can run
    // immediately and interrupt the hung startup instead of waiting 10s.
    const creation = h.root.serial('agent/created', { agent, source: 'startup' })
    await new Promise(resolve => setTimeout(resolve, 20))
    const startedAt = Date.now()

    await fiber.dispose()
    await creation

    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('interrupts an in-flight backfill startup when the plugin is disposed', async () => {
    const agents: Agent[] = []
    const h = harness({ agents })
    const { agent } = await agentRig(h.root, 'agent-backfill-inflight')
    agents.push(agent)
    let disconnects = 0
    const hung = {
      then() {},
      dispose: async () => {
        disconnects += 1
      },
    } as unknown as Fiber & PromiseLike<Fiber>

    const fiber = autoloader(h, {
      config: Config({ startupTimeoutMs: 10_000, skills: false }),
      mount: () => hung,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    const startedAt = Date.now()

    await fiber.dispose()

    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(disconnects).toBe(1)
  })

  it('stops waiting for a backfill mount when creation is cancelled', async () => {
    const agents: Agent[] = []
    const h = harness({ agents })
    const { agent } = await agentRig(h.root, 'agent-backfill-cancelled')
    agents.push(agent)
    const hung = {
      then() {},
      dispose: async () => {},
    } as unknown as Fiber & PromiseLike<Fiber>

    const fiber = autoloader(h, {
      config: Config({ startupTimeoutMs: 10_000, skills: false }),
      mount: () => hung,
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 20))
      const controller = new AbortController()
      const creation = h.root.serial('agent/created', { agent, source: 'startup', signal: controller.signal })
      const startedAt = Date.now()
      setTimeout(() => controller.abort(), 20)

      await expect(creation).resolves.toBeUndefined()
      expect(Date.now() - startedAt).toBeLessThan(5_000)
    } finally {
      await fiber.dispose()
    }
  })

  it('does not mount after a cancelled creation aborts the in-flight backfill', async () => {
    const agents: Agent[] = []
    const h = harness({ agents })
    const { agent } = await agentRig(h.root, 'agent-backfill-cancelled-mount')
    agents.push(agent)
    let releaseDiscovery: (() => void) | undefined
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve })

    const fiber = autoloader(h, {
      discover: async () => {
        await discoveryGate
        return LOCATION
      },
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 20))
      const controller = new AbortController()
      const creation = h.root.serial('agent/created', { agent, source: 'startup', signal: controller.signal })
      controller.abort()
      releaseDiscovery?.()

      await expect(creation).resolves.toBeUndefined()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(h.mounted).toHaveLength(0)
    } finally {
      releaseDiscovery?.()
      await fiber.dispose()
    }
  })

  it('disconnects the MCP client when the Agent is disposed', async () => {
    const h = harness()
    await autoloader(h)
    const { agent, holder } = await agentRig(h.root, 'agent-disposable')
    await h.root.serial('agent/created', { agent, source: 'startup' })
    expect(h.disposals).toHaveLength(0)

    await holder.dispose()

    expect(h.disposals).toEqual(['mcp-client'])
  })

  it('disconnects every mounted MCP client when the plugin is disposed', async () => {
    const h = harness()
    const fiber = autoloader(h)
    await fiber
    const first = await agentRig(h.root, 'agent-first')
    const second = await agentRig(h.root, 'agent-second')
    await h.root.serial('agent/created', { agent: first.agent, source: 'startup' })
    await h.root.serial('agent/created', { agent: second.agent, source: 'startup' })
    expect(h.disposals).toHaveLength(0)

    await fiber.dispose()

    expect(h.disposals).toEqual(['mcp-client', 'mcp-client'])
  })
})