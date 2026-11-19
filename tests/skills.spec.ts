import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, defaultSkillsCacheDir, listExportedSkills, loadExportedSkill, startAutoloader } from '../src/index.ts'
import type { XcodeProjectLocation } from '../src/index.ts'

const PROJECT_ROOT = '/tmp/Example'
const LOCATION: XcodeProjectLocation = { root: PROJECT_ROOT, project: 'Example.xcodeproj' }

const cleanups: Array<() => Promise<void>> = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
  await Promise.allSettled(temporaryDirectories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-xcode-mcp-skills-'))
  temporaryDirectories.push(directory)
  return directory
}

async function writeSkill(cacheDir: string, name: string, frontmatter: string, body = 'Instruction body.\n'): Promise<void> {
  await mkdir(join(cacheDir, name), { recursive: true })
  await writeFile(join(cacheDir, name, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
}

const VALID_FRONTMATTER = 'name: swiftui-specialist\ndescription: "SwiftUI guidance from Apple."'

interface ScopedAgent {
  agent: Agent
  key: object
  dispose: () => Promise<void>
}

interface Rig {
  root: Context
  cacheDir: string
  mounted: unknown[]
  exportCalls: () => number
  autoloader: (options?: {
    config?: Config
    exportSkills?: (cacheDir: string, signal: AbortSignal) => Promise<void>
    agents?: Agent[]
  }) => Fiber & PromiseLike<Fiber>
  scopedAgent: (id: string) => Promise<ScopedAgent>
}

async function rig(): Promise<Rig> {
  const root = new Context()
  cleanups.push(() => root.fiber.dispose())
  const registry = root.plugin(SkillRegistry)
  await registry
  const cacheDir = await temporaryDirectory()
  const mounted: unknown[] = []
  let exportCalls = 0
  const agents: Agent[] = []
  root.provide('workingDirectory', { ensure: async () => PROJECT_ROOT } as never)
  root.provide('agents', { list: () => agents } as never)
  const stub = {
    name: 'stub-mcp-client',
    apply(stubCtx: Context, _config: unknown) {
      stubCtx.effect(() => () => {})
    },
  }
  return {
    root,
    cacheDir,
    mounted,
    exportCalls: () => exportCalls,
    autoloader(options = {}) {
      if (options.agents !== undefined) agents.push(...options.agents)
      const fiber = root.plugin({
        name: 'test-xcode-mcp-autoload',
        inject: ['workingDirectory', 'agents'],
        apply: (ctx: Context) => startAutoloader(ctx, options.config ?? Config({}), {
          discoverProjectRoot: async () => LOCATION,
          probeBridge: async () => true,
          skillsCacheDir: cacheDir,
          exportSkills: options.exportSkills ?? (async (dir) => {
            exportCalls += 1
            await writeSkill(dir, 'swiftui-specialist', VALID_FRONTMATTER)
          }),
          mount(agent, config) {
            mounted.push(config)
            return agent.ctx.plugin(stub, config)
          },
        }),
      })
      return fiber
    },
    async scopedAgent(id) {
      const key = { id }
      const scope = createScope(root, key)
      cleanups.push(() => scope.dispose())
      return { agent: { id, ctx: scope.ctx } as unknown as Agent, key, dispose: () => scope.dispose() }
    },
  }
}

describe('embedded Xcode skills', () => {
  it('exports once per activation and registers skills only for the Xcode Agent', async () => {
    const r = await rig()
    const fiber = r.autoloader()
    await fiber
    const { agent, key } = await r.scopedAgent('agent-skills')
    const other = await r.scopedAgent('agent-other')

    await r.root.serial('agent/created', { agent, source: 'startup' })

    await vi.waitFor(async () => {
      const skills = await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })
      expect(skills.map(skill => skill.name)).toEqual(['swiftui-specialist'])
    })
    expect(r.exportCalls()).toBe(1)
    expect(await r.root.skills.list({ cwd: PROJECT_ROOT })).toEqual([])
    expect(await r.root.skills.list({ scope: other.key, cwd: PROJECT_ROOT })).toEqual([])
  })

  it('backfills skills for Agents that already exist at activation', async () => {
    const r = await rig()
    const { agent, key } = await r.scopedAgent('agent-backfill')
    const agents: Agent[] = [agent]
    const fiber = r.autoloader({ agents })
    await fiber

    await vi.waitFor(async () => {
      expect(await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })).toHaveLength(1)
    })
  })

  it('loads the body on demand with a directory resource base', async () => {
    const r = await rig()
    await r.autoloader()
    const { agent, key } = await r.scopedAgent('agent-load')
    await r.root.serial('agent/created', { agent, source: 'startup' })
    await vi.waitFor(async () => {
      expect(await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })).toHaveLength(1)
    })

    const skill = await r.root.skills.get('swiftui-specialist', { scope: key, cwd: PROJECT_ROOT })

    expect(skill).toMatchObject({
      name: 'swiftui-specialist',
      description: 'SwiftUI guidance from Apple.',
      content: 'Instruction body.\n',
      source: 'bundled',
      provider: 'xcode',
      path: join(r.cacheDir, 'swiftui-specialist', 'SKILL.md'),
      resourceBase: { kind: 'directory', path: join(r.cacheDir, 'swiftui-specialist') },
      invocation: { modelInvocable: true, userInvocable: true },
    })
  })

  it('refreshes catalogs when a deferred export lands', async () => {
    const r = await rig()
    let landExport: (() => void) | undefined
    const deferred = new Promise<void>((resolve) => { landExport = resolve })
    await r.autoloader({
      exportSkills: async (dir) => {
        await deferred
        await writeSkill(dir, 'swiftui-specialist', VALID_FRONTMATTER)
      },
    })
    const { agent, key } = await r.scopedAgent('agent-deferred')
    await r.root.serial('agent/created', { agent, source: 'startup' })
    // The provider registered, but the cache is still empty.
    await vi.waitFor(async () => {
      const provider = await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })
      expect(provider).toEqual([])
    })

    landExport?.()

    await vi.waitFor(async () => {
      expect(await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })).toHaveLength(1)
    })
  })

  it('keeps activation, Agent creation, and the MCP mount working when the export fails', async () => {
    const r = await rig()
    const fiber = r.autoloader({
      exportSkills: async () => {
        throw new Error('xcrun missing')
      },
    })
    await expect(fiber).resolves.toBeDefined()
    const { agent, key } = await r.scopedAgent('agent-export-failed')

    await expect(r.root.serial('agent/created', { agent, source: 'startup' })).resolves.toBeUndefined()

    expect(r.mounted).toHaveLength(1)
    expect(await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })).toEqual([])
  })

  it('keeps previously cached skills when a later export fails', async () => {
    const r = await rig()
    await writeSkill(r.cacheDir, 'swiftui-specialist', VALID_FRONTMATTER)
    await r.autoloader({
      exportSkills: async () => {
        throw new Error('xcrun missing')
      },
    })
    const { agent, key } = await r.scopedAgent('agent-stale-cache')
    await r.root.serial('agent/created', { agent, source: 'startup' })

    await vi.waitFor(async () => {
      expect(await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })).toHaveLength(1)
    })
  })

  it('skips malformed bundles and keeps their readable siblings', async () => {
    const r = await rig()
    await r.autoloader({
      exportSkills: async (dir) => {
        await writeSkill(dir, 'swiftui-specialist', VALID_FRONTMATTER)
        await writeSkill(dir, 'broken', 'name: broken\ndescription: "no closing frontmatter')
        await writeSkill(dir, 'Bad_Name', 'name: Bad_Name\ndescription: "not kebab-case"')
        await writeSkill(dir, 'no-description', 'name: no-description')
      },
    })
    const { agent, key } = await r.scopedAgent('agent-malformed')
    await r.root.serial('agent/created', { agent, source: 'startup' })

    await vi.waitFor(async () => {
      const skills = await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })
      expect(skills.map(skill => skill.name)).toEqual(['swiftui-specialist'])
    })
  })

  it('honors the invocation policy frontmatter', async () => {
    const r = await rig()
    await r.autoloader({
      exportSkills: async (dir) => {
        await writeSkill(dir, 'user-only', 'name: user-only\ndescription: "human only"\ndisable-model-invocation: true')
      },
    })
    const { agent, key } = await r.scopedAgent('agent-policy')
    await r.root.serial('agent/created', { agent, source: 'startup' })

    await vi.waitFor(async () => {
      const skills = await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })
      expect(skills).toHaveLength(1)
      expect(skills[0]?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
    })
  })

  it('unregisters the provider when the Agent is disposed', async () => {
    const r = await rig()
    await r.autoloader()
    const { agent, key, dispose } = await r.scopedAgent('agent-disposed')
    await r.root.serial('agent/created', { agent, source: 'startup' })
    await vi.waitFor(async () => {
      expect(await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })).toHaveLength(1)
    })

    await dispose()

    expect(await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })).toEqual([])
  })

  it('unregisters the provider when the plugin is disposed', async () => {
    const r = await rig()
    const fiber = r.autoloader()
    await fiber
    const { agent, key } = await r.scopedAgent('agent-plugin-disposed')
    await r.root.serial('agent/created', { agent, source: 'startup' })
    await vi.waitFor(async () => {
      expect(await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })).toHaveLength(1)
    })

    await fiber.dispose()

    expect(await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })).toEqual([])
  })

  it('skills: false disables both the export and the registration', async () => {
    const r = await rig()
    await r.autoloader({ config: Config({ skills: false }) })
    const { agent, key } = await r.scopedAgent('agent-disabled')
    await r.root.serial('agent/created', { agent, source: 'startup' })

    expect(r.exportCalls()).toBe(0)
    expect(r.mounted).toHaveLength(1)
    expect(await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })).toEqual([])
  })
})

describe('skills cache helpers', () => {
  it('honors DSH_HOME for the default cache directory', () => {
    const previous = process.env['DSH_HOME']
    try {
      process.env['DSH_HOME'] = '/tmp/dsh-home'
      expect(defaultSkillsCacheDir()).toBe('/tmp/dsh-home/cache/dsh-xcode-mcp/skills')
      delete process.env['DSH_HOME']
      expect(defaultSkillsCacheDir()).toContain('.dsh')
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })

  it('treats a missing cache directory as a valid empty state', async () => {
    const directory = await temporaryDirectory()
    await expect(listExportedSkills(join(directory, 'absent'))).resolves.toEqual([])
  })

  it('returns undefined when a loaded bundle no longer matches the candidate name', async () => {
    const directory = await temporaryDirectory()
    await writeSkill(directory, 'swiftui-specialist', VALID_FRONTMATTER)
    const [candidate] = await listExportedSkills(directory)
    expect(candidate).toBeDefined()
    await writeSkill(directory, 'swiftui-specialist', 'name: renamed\ndescription: "renamed"')

    await expect(loadExportedSkill(candidate!)).resolves.toBeUndefined()
  })
})