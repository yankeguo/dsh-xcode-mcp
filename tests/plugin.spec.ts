import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-working-directory'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, startAutoloader } from '../src/index.ts'
import type { XcodeProjectLocation } from '../src/index.ts'

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
    mount?: Harness['mount']
  } = {},
): Fiber & PromiseLike<Fiber> {
  return harnessValue.root.plugin({
    name: 'test-xcode-mcp-autoload',
    inject: ['workingDirectory', 'agents'],
    apply: (ctx: Context) => startAutoloader(ctx, options.config ?? Config({}), {
      discoverProjectRoot: options.discover ?? (async () => LOCATION),
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
      config: Config({ startupTimeoutMs: 20 }),
      mount: () => hung,
    })
    const { agent } = await agentRig(h.root, 'agent-hung')

    await expect(h.root.serial('agent/created', { agent, source: 'startup' })).resolves.toBeUndefined()

    expect(disconnects).toBe(1)
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