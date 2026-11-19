import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-working-directory'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, defaultSkillsCacheDir, exportXcodeSkills, listExportedSkills, loadExportedSkill, startAutoloader } from '../src/index.ts'
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

async function rigScopedAgent(root: Context, id: string): Promise<ScopedAgent> {
  const key = { id }
  const scope = createScope(root, key)
  cleanups.push(() => scope.dispose())
  return { agent: { id, ctx: scope.ctx } as unknown as Agent, key, dispose: () => scope.dispose() }
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

  it('aborts an in-flight skills export when the plugin is disposed', async () => {
    const root = new Context()
    cleanups.push(() => root.fiber.dispose())
    root.provide('workingDirectory', { ensure: async () => PROJECT_ROOT } as never)
    root.provide('agents', { list: () => [] } as never)
    const cacheDir = await temporaryDirectory()
    let started: (() => void) | undefined
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    let aborted = false
    const fiber = root.plugin({
      name: 'test-xcode-mcp-autoload',
      inject: ['workingDirectory', 'agents'],
      apply: (ctx: Context) => startAutoloader(ctx, Config({}), {
        discoverProjectRoot: async () => LOCATION,
        probeBridge: async () => true,
        skillsCacheDir: cacheDir,
        exportSkills: async (_dir, signal) => {
          started?.()
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              aborted = true
              resolve()
              return
            }
            signal.addEventListener('abort', () => {
              aborted = true
              resolve()
            }, { once: true })
          })
        },
      }),
    })
    await fiber
    await startedPromise

    await fiber.dispose()

    expect(aborted).toBe(true)
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

  it('warns through the provider when skills.get hits an unreadable SKILL.md', async () => {
    const r = await rig()
    const warnings: string[] = []
    r.root.logger.exporter({
      levels: { default: 1 },
      export: ({ type, args }) => {
        if (type === 'warn') warnings.push(String(args[0]))
      },
    })
    await r.autoloader()
    const { agent, key } = await r.scopedAgent('agent-get-unreadable')
    await r.root.serial('agent/created', { agent, source: 'startup' })
    await vi.waitFor(async () => {
      expect(await r.root.skills.list({ scope: key, cwd: PROJECT_ROOT })).toHaveLength(1)
    })
    const skillFile = join(r.cacheDir, 'swiftui-specialist', 'SKILL.md')
    await rm(skillFile)
    await mkdir(skillFile)

    await expect(r.root.skills.get('swiftui-specialist', { scope: key, cwd: PROJECT_ROOT })).resolves.toBeUndefined()
    expect(warnings.some(message => message.includes('cannot load Xcode skill'))).toBe(true)
  })

  it('warns when a bundle file cannot be read', async () => {
    const directory = await temporaryDirectory()
    await writeSkill(directory, 'swiftui-specialist', VALID_FRONTMATTER)
    // A directory where SKILL.md should be fails the read with EISDIR/EACCES.
    await mkdir(join(directory, 'unreadable', 'SKILL.md'), { recursive: true })
    const warn = vi.fn()

    const skills = await listExportedSkills(directory, { warn })

    expect(skills.map(skill => skill.name)).toEqual(['swiftui-specialist'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping unreadable or malformed'), expect.any(Error))
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

  it('warns and cleans the invalidator when provider registration fails asynchronously', async () => {
    const root = new Context()
    cleanups.push(() => root.fiber.dispose())
    const warnings: string[] = []
    root.logger.exporter({
      levels: { default: 1 },
      export: ({ type, args }) => {
        if (type === 'warn') warnings.push(String(args[0]))
      },
    })
    let invalidateCalls = 0
    root.provide('skills', {
      registerProvider(create: (control: { signal: AbortSignal; invalidate: () => void }) => unknown) {
        const control = {
          signal: new AbortController().signal,
          invalidate: () => { invalidateCalls += 1 },
        }
        // The real registry calls the factory before layer insertion.
        create(control)
        throw new Error('duplicate provider')
      },
    } as never)
    root.provide('workingDirectory', { ensure: async () => PROJECT_ROOT } as never)
    root.provide('agents', { list: () => [] } as never)
    const cacheDir = await temporaryDirectory()
    const mounted: unknown[] = []
    const stub = {
      name: 'stub-mcp-client',
      apply(stubCtx: Context, _config: unknown) {
        stubCtx.effect(() => () => {})
      },
    }
    let releaseExport: (() => void) | undefined
    const exportGate = new Promise<void>((resolve) => { releaseExport = resolve })
    const fiber = root.plugin({
      name: 'test-xcode-mcp-autoload',
      inject: ['workingDirectory', 'agents'],
      apply: (ctx: Context) => startAutoloader(ctx, Config({}), {
        discoverProjectRoot: async () => LOCATION,
        probeBridge: async () => true,
        skillsCacheDir: cacheDir,
        exportSkills: async () => { await exportGate },
        mount(agent, config) {
          mounted.push(config)
          return agent.ctx.plugin(stub, config)
        },
      }),
    })
    await fiber
    const { agent } = await rigScopedAgent(root, 'agent-provider-failed')

    await expect(root.serial('agent/created', { agent, source: 'startup' })).resolves.toBeUndefined()
    await vi.waitFor(() => {
      expect(warnings.some(message => message.includes('cannot register Xcode skills'))).toBe(true)
    })
    expect(mounted).toHaveLength(1)

    // A leaked invalidator would be called by the completed export below.
    releaseExport?.()
    await vi.waitFor(() => expect(invalidateCalls).toBe(0))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(invalidateCalls).toBe(0)
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
  it('resolves the default cache directory like DSH home resolution', () => {
    const suffix = join('cache', 'dsh-xcode-mcp', 'skills')
    expect(defaultSkillsCacheDir({ DSH_HOME: '/tmp/dsh-home' })).toBe(join('/tmp/dsh-home', suffix))
    expect(defaultSkillsCacheDir({ DSH_HOME: '' })).toBe(join(homedir(), '.dsh', suffix))
    expect(defaultSkillsCacheDir({ DSH_HOME: '   ' })).toBe(join(homedir(), '.dsh', suffix))
    expect(defaultSkillsCacheDir({ DSH_HOME: '~' })).toBe(join(homedir(), suffix))
    expect(defaultSkillsCacheDir({ DSH_HOME: '~/custom' })).toBe(join(homedir(), 'custom', suffix))
    expect(defaultSkillsCacheDir({ DSH_HOME: 'relative-home' })).toBe(join(resolve('relative-home'), suffix))
  })

  it('reads Xcode’s snake_case when_to_use and the DSH camelCase spelling', async () => {
    const directory = await temporaryDirectory()
    await writeSkill(directory, 'camel', 'name: camel\ndescription: "camel"\nwhenToUse: camel hint')
    await writeSkill(directory, 'snake', 'name: snake\ndescription: "snake"\nwhen_to_use: |\n  snake hint\n  second line')

    const candidates = await listExportedSkills(directory)

    expect(candidates.map(candidate => [candidate.name, candidate.whenToUse])).toEqual([
      ['camel', 'camel hint'],
      ['snake', 'snake hint\nsecond line\n'],
    ])
  })

  it('passes the configured command and env to the skills export', async () => {
    const directory = await temporaryDirectory()
    const fake = join(directory, 'fake-xcrun')
    await writeFile(fake, '#!/bin/sh\n[ "$DSH_XCODE_EXPORT_MARK" = yes ]\n', { mode: 0o755 })
    const cacheDir = join(directory, 'cache')

    await expect(exportXcodeSkills(cacheDir, undefined, {
      command: fake,
      env: { DSH_XCODE_EXPORT_MARK: 'yes' },
    })).resolves.toBeUndefined()
    await expect(exportXcodeSkills(cacheDir, undefined, {
      command: fake,
      env: { DSH_XCODE_EXPORT_MARK: 'no' },
    })).rejects.toThrow(/agent skills export failed/)
  })

  it('warns when the cache path is not a directory', async () => {
    const directory = await temporaryDirectory()
    const cacheFile = join(directory, 'cache-file')
    await writeFile(cacheFile, 'not a directory')
    const warn = vi.fn()

    await expect(listExportedSkills(cacheFile, { warn })).resolves.toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot list Xcode skills'), expect.any(Error))
  })

  it('reads DSH_HOME from process.env when no env argument is given', () => {
    const previous = process.env['DSH_HOME']
    try {
      process.env['DSH_HOME'] = '/tmp/dsh-home-from-process'
      expect(defaultSkillsCacheDir()).toBe('/tmp/dsh-home-from-process/cache/dsh-xcode-mcp/skills')
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })

  it('treats a missing cache directory as a valid empty state', async () => {
    const directory = await temporaryDirectory()
    await expect(listExportedSkills(join(directory, 'absent'))).resolves.toEqual([])
  })

  it('warns and returns undefined when the loaded bundle hits EISDIR', async () => {
    const directory = await temporaryDirectory()
    await writeSkill(directory, 'swiftui-specialist', VALID_FRONTMATTER)
    const [candidate] = await listExportedSkills(directory)
    expect(candidate).toBeDefined()
    const skillFile = join(directory, 'swiftui-specialist', 'SKILL.md')
    await rm(skillFile)
    await mkdir(skillFile)
    const warn = vi.fn()

    await expect(loadExportedSkill(candidate!, undefined, { warn })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot load Xcode skill'), expect.any(Error))
  })

  it.skipIf(process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0))(
    'warns and returns undefined when the loaded bundle hits EACCES',
    async () => {
      const directory = await temporaryDirectory()
      await writeSkill(directory, 'swiftui-specialist', VALID_FRONTMATTER)
      const [candidate] = await listExportedSkills(directory)
      expect(candidate).toBeDefined()
      const skillFile = join(directory, 'swiftui-specialist', 'SKILL.md')
      await chmod(skillFile, 0o000)
      const warn = vi.fn()
      try {
        await expect(loadExportedSkill(candidate!, undefined, { warn })).resolves.toBeUndefined()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot load Xcode skill'), expect.any(Error))
      } finally {
        await chmod(skillFile, 0o644)
      }
    },
  )

  it('returns undefined when a loaded bundle no longer matches the candidate name', async () => {
    const directory = await temporaryDirectory()
    await writeSkill(directory, 'swiftui-specialist', VALID_FRONTMATTER)
    const [candidate] = await listExportedSkills(directory)
    expect(candidate).toBeDefined()
    await writeSkill(directory, 'swiftui-specialist', 'name: renamed\ndescription: "renamed"')

    await expect(loadExportedSkill(candidate!)).resolves.toBeUndefined()
  })
})