import { describe, expect, it } from 'vitest'
import { Config, createMountConfig } from '../src/index.ts'

const PROJECT_ROOT = '/tmp/Example'

describe('Config', () => {
  it('defaults to the verified uv launcher for this machine', () => {
    expect(Config({})).toEqual({
      serverName: 'xcode',
      command: '/Users/guoyk/.local/bin/uv',
      args: ['run', '/Users/guoyk/Workspace/dsh/scripts/xcode-mcp.py'],
      env: { UV_DEFAULT_INDEX: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
      startupTimeoutMs: 30_000,
    })
  })

  it('accepts overrides for every runtime field', () => {
    expect(Config({
      serverName: 'xcode-preview',
      command: '/usr/local/bin/uv',
      args: ['run', '/opt/xcode-mcp.py'],
      env: { UV_DEFAULT_INDEX: 'https://example.invalid/simple' },
      startupTimeoutMs: 1234,
    })).toEqual({
      serverName: 'xcode-preview',
      command: '/usr/local/bin/uv',
      args: ['run', '/opt/xcode-mcp.py'],
      env: { UV_DEFAULT_INDEX: 'https://example.invalid/simple' },
      startupTimeoutMs: 1234,
    })
  })

  it('rejects a server name that cannot appear in a tool name', () => {
    expect(() => Config({ serverName: 'not a name' })).toThrow()
  })
})

describe('createMountConfig', () => {
  it('builds a stdio client rooted at the discovered project', () => {
    const mounted = createMountConfig(Config({}), PROJECT_ROOT)

    expect(mounted).toMatchObject({
      transport: 'stdio',
      serverName: 'xcode',
      command: '/Users/guoyk/.local/bin/uv',
      args: ['run', '/Users/guoyk/Workspace/dsh/scripts/xcode-mcp.py'],
      env: { UV_DEFAULT_INDEX: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
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