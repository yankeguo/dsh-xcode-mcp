import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Config, createMountConfig, probeMcpBridge } from '../src/index.ts'

const PROJECT_ROOT = '/tmp/Example'

describe('Config', () => {
  it('defaults to the system xcrun mcpbridge launcher', () => {
    expect(Config({})).toEqual({
      serverName: 'xcode',
      command: 'xcrun',
      args: ['mcpbridge'],
      env: {},
      startupTimeoutMs: 30_000,
      skills: true,
    })
  })

  it('accepts overrides for every runtime field', () => {
    expect(Config({
      serverName: 'xcode-preview',
      command: '/usr/local/bin/custom-mcp',
      args: ['serve', '--stdio'],
      env: { CUSTOM: 'value' },
      startupTimeoutMs: 1234,
      skills: false,
    })).toEqual({
      serverName: 'xcode-preview',
      command: '/usr/local/bin/custom-mcp',
      args: ['serve', '--stdio'],
      env: { CUSTOM: 'value' },
      startupTimeoutMs: 1234,
      skills: false,
    })
  })

  it('rejects a server name that cannot appear in a tool name', () => {
    expect(() => Config({ serverName: 'not a name' })).toThrow()
    expect(() => Config({ serverName: '' })).toThrow()
    expect(() => Config({ serverName: 'x'.repeat(33) })).toThrow()
  })

  it('rejects a blank command', () => {
    expect(() => Config({ command: '' })).toThrow()
    expect(() => Config({ command: '   ' })).toThrow()
  })

  it('bounds the startup watchdog to Node’s timer range', () => {
    expect(() => Config({ startupTimeoutMs: 0 })).toThrow()
    expect(() => Config({ startupTimeoutMs: 2_147_483_648 })).toThrow()
    expect(Config({ startupTimeoutMs: 2_147_483_647 }).startupTimeoutMs).toBe(2_147_483_647)
  })

  it('rejects NaN and fractional watchdogs instead of letting them collapse the timer', () => {
    expect(() => Config({ startupTimeoutMs: Number.NaN })).toThrow()
    expect(() => Config({ startupTimeoutMs: 1.5 })).toThrow()
  })
})

describe('createMountConfig', () => {
  it('builds a stdio client rooted at the discovered project', () => {
    const mounted = createMountConfig(Config({}), PROJECT_ROOT)

    expect(mounted).toMatchObject({
      transport: 'stdio',
      serverName: 'xcode',
      command: 'xcrun',
      args: ['mcpbridge'],
      env: {},
      cwd: PROJECT_ROOT,
      failOnStartupError: false,
    })
    expect(mounted.toolCallTimeoutMs).toBe(60_000)
  })

  it('keeps overrides and the discovered working directory together', () => {
    const mounted = createMountConfig(Config({
      serverName: 'xcode-preview',
      command: '/bin/echo',
      args: ['hello'],
      env: { CUSTOM: 'value' },
      startupTimeoutMs: 999,
    }), '/tmp/Other')

    expect(mounted).toMatchObject({
      serverName: 'xcode-preview',
      command: '/bin/echo',
      args: ['hello'],
      env: { CUSTOM: 'value' },
      cwd: '/tmp/Other',
    })
  })
})

describe('probeMcpBridge', () => {
  it('trusts custom launchers without spawning anything', async () => {
    await expect(probeMcpBridge('/bin/echo', ['hello'])).resolves.toBe(true)
    await expect(probeMcpBridge('xcrun', ['something-else'])).resolves.toBe(true)
    await expect(probeMcpBridge('/usr/bin/xcrun', [])).resolves.toBe(true)
  })

  it('reports a missing xcrun executable as unavailable', async () => {
    await expect(probeMcpBridge('/nonexistent/xcrun', ['mcpbridge'])).resolves.toBe(false)
  })

  it('resolves the real xcrun probe to a boolean on every platform', async () => {
    // macOS with Xcode 26+ resolves true; CI without xcrun resolves false.
    expect(typeof await probeMcpBridge('xcrun', ['mcpbridge'])).toBe('boolean')
  })

  it('passes extra env to the mcpbridge probe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-xcode-mcp-probe-'))
    try {
      const fake = join(directory, 'xcrun')
      await writeFile(fake, '#!/bin/sh\n[ "$DSH_XCODE_PROBE_MARK" = yes ]\n', { mode: 0o755 })
      const env = {
        PATH: `${directory}:${process.env['PATH'] ?? ''}`,
        DSH_XCODE_PROBE_MARK: 'yes',
      }
      await expect(probeMcpBridge('xcrun', ['mcpbridge'], env)).resolves.toBe(true)
      await expect(probeMcpBridge('xcrun', ['mcpbridge'], { ...env, DSH_XCODE_PROBE_MARK: 'no' })).resolves.toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})