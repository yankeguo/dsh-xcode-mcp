import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findXcodeProjectRoot } from '../src/index.ts'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-xcode-mcp-discovery-'))
  temporaryDirectories.push(directory)
  return directory
}

async function project(directory: string, name: string): Promise<void> {
  await mkdir(join(directory, name), { recursive: true })
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('findXcodeProjectRoot', () => {
  it('returns the working directory itself when it contains an Xcode project', async () => {
    const root = await temporaryDirectory()
    await project(root, 'App.xcodeproj')

    await expect(findXcodeProjectRoot(root)).resolves.toEqual({ root, project: 'App.xcodeproj' })
  })

  it('returns the nearest ancestor containing an Xcode project', async () => {
    const root = await temporaryDirectory()
    const nested = join(root, 'App', 'Sources', 'Feature')
    await mkdir(nested, { recursive: true })
    await project(join(root, 'App'), 'App.xcodeproj')

    await expect(findXcodeProjectRoot(nested)).resolves.toEqual({ root: join(root, 'App'), project: 'App.xcodeproj' })
  })

  it('prefers the closest project when projects are nested', async () => {
    const root = await temporaryDirectory()
    const nested = join(root, 'Outer', 'Inner', 'Sources')
    await mkdir(nested, { recursive: true })
    await project(join(root, 'Outer'), 'Outer.xcodeproj')
    await project(join(root, 'Outer', 'Inner'), 'Inner.xcodeproj')

    await expect(findXcodeProjectRoot(nested)).resolves.toEqual({
      root: join(root, 'Outer', 'Inner'),
      project: 'Inner.xcodeproj',
    })
  })

  it('returns no project for a directory tree without one', async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, 'Sources'), { recursive: true })

    await expect(findXcodeProjectRoot(join(root, 'Sources'))).resolves.toBeUndefined()
  })

  it('does not treat a file named *.xcodeproj as a project directory', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'App.xcodeproj'), 'not a directory')

    await expect(findXcodeProjectRoot(root)).resolves.toBeUndefined()
  })

  it('stops at the enclosing .git root instead of searching its parents', async () => {
    const root = await temporaryDirectory()
    const repository = join(root, 'Repo')
    const inside = join(repository, 'Sources', 'Deep')
    await mkdir(join(repository, '.git'), { recursive: true })
    await mkdir(inside, { recursive: true })
    await project(root, 'Outside.xcodeproj')

    await expect(findXcodeProjectRoot(inside)).resolves.toBeUndefined()
  })

  it('checks the .git root itself before stopping', async () => {
    const root = await temporaryDirectory()
    const repository = join(root, 'Repo')
    await mkdir(join(repository, '.git'), { recursive: true })
    await project(repository, 'Repo.xcodeproj')

    await expect(findXcodeProjectRoot(join(repository, '.git'))).resolves.toEqual({
      root: repository,
      project: 'Repo.xcodeproj',
    })
  })

  it('accepts a .git file as a repository marker', async () => {
    const root = await temporaryDirectory()
    const worktree = join(root, 'Worktree')
    await mkdir(join(worktree, 'Sources'), { recursive: true })
    await writeFile(join(worktree, '.git'), 'gitdir: /elsewhere\n')

    await expect(findXcodeProjectRoot(join(worktree, 'Sources'))).resolves.toBeUndefined()
  })

  it('picks a deterministic project when one directory holds several', async () => {
    const root = await temporaryDirectory()
    await project(root, 'Zeta.xcodeproj')
    await project(root, 'Alpha.xcodeproj')

    await expect(findXcodeProjectRoot(root)).resolves.toEqual({ root, project: 'Alpha.xcodeproj' })
  })

  it('recognizes a symlinked project directory', async () => {
    const root = await temporaryDirectory()
    const elsewhere = join(root, 'Elsewhere')
    await project(elsewhere, 'Real.xcodeproj')
    const workspace = join(root, 'Workspace')
    await mkdir(workspace, { recursive: true })
    await symlink(join(elsewhere, 'Real.xcodeproj'), join(workspace, 'Linked.xcodeproj'), 'dir')

    await expect(findXcodeProjectRoot(workspace)).resolves.toEqual({ root: workspace, project: 'Linked.xcodeproj' })
  })

  it('does not treat a symlink to a file as a project directory', async () => {
    const root = await temporaryDirectory()
    await writeFile(join(root, 'target.txt'), 'not a project')
    await symlink(join(root, 'target.txt'), join(root, 'Fake.xcodeproj'), 'file')

    await expect(findXcodeProjectRoot(root)).resolves.toBeUndefined()
  })

  it('ignores a dangling project symlink', async () => {
    const root = await temporaryDirectory()
    await symlink(join(root, 'missing'), join(root, 'Broken.xcodeproj'), 'dir')

    await expect(findXcodeProjectRoot(root)).resolves.toBeUndefined()
  })

  it('keeps the lexicographic order across real and symlinked projects', async () => {
    const root = await temporaryDirectory()
    const elsewhere = join(root, 'Elsewhere')
    await project(elsewhere, 'Real.xcodeproj')
    await project(root, 'Zeta.xcodeproj')
    await symlink(join(elsewhere, 'Real.xcodeproj'), join(root, 'Alpha.xcodeproj'), 'dir')

    await expect(findXcodeProjectRoot(root)).resolves.toEqual({ root, project: 'Alpha.xcodeproj' })
  })
})