#!/usr/bin/env node
/**
 * Promote the already-staged release of @yankeguo/dsh-xcode-mcp: approve the
 * staged package version (which publishes it) and create or update the GitHub
 * Release.
 *
 * This is the human half of the staged-publishing release pipeline:
 * .github/workflows/publish.yml stages the package with a short-lived OIDC
 * token and publishes nothing; a maintainer then runs this script locally with
 * an interactive `npm login` session and answers the registry 2FA prompt.
 * There is deliberately no CI shortcut for approval: npm only accepts OIDC
 * tokens for `npm stage publish`/`npm publish`, never for
 * `npm stage list`/`approve`/`reject`.
 *
 * Two-phase design:
 *   1. Preflight (read-only):
 *        - exactly one staged record for <name>@<version>  -> approve it,
 *        - zero staged records but the version is published -> skip (a retry
 *          after a partial failure, or a manually first-published version, is
 *          idempotent),
 *        - zero staged records and the version is not published -> fail.
 *      Also validates npm login, npm stage support, gh auth, the release tag
 *      (existing tag only, never created or moved), and the notes file before
 *      the first irreversible approval.
 *   2. Approve the staged id with inherited stdio, so npm can prompt for the
 *      one-time password interactively. Stops at the first failure and prints
 *      what remains staged.
 *   3. Create or update the GitHub Release idempotently (gh release
 *      view/edit/create --verify-tag). Prerelease versions (-rc.N etc.) are
 *      marked --prerelease (and never --latest); stable releases are explicitly
 *      kept non-prerelease on edit.
 *
 * Usage:
 *   node scripts/promote-release.mjs [options]
 *
 * Options:
 *   --version <x.y.z>    Release version. Default: root package.json version.
 *   --release-tag <tag>  GitHub Release tag. Default: v<version>.
 *   --repo <owner/repo>  GitHub repository. Default: the origin git remote,
 *                        falling back to yankeguo/dsh-xcode-mcp.
 *   --notes-file <path>  Release notes. Default: docs/releases/v<version>.md
 *                        (relative paths resolve from the repository root).
 *   --dry-run            Full preflight and plan read-only: validates registry
 *                        state, npm login, gh auth, tag, and notes file, prints
 *                        the approve/release plan, mutates nothing.
 *   --list-only          Print the staged state of the package and exit; does
 *                        not require gh auth and never mutates.
 *   -h, --help           Show this help.
 *
 * Requires: node >= 24.9, npm >= 11.15.0 (CI pins 11.20.0) logged in
 * (`npm login`; 2FA enabled), gh >= 2.0 authenticated (`gh auth status`), and
 * the release tag already pushed to origin.
 *
 * Exit codes: 0 success (or already complete), 1 preflight/approve/release
 * failure, 2 invalid invocation.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = '@yankeguo/dsh-xcode-mcp'
/** Known GitHub repository; used when no origin remote is configured yet. */
const DEFAULT_REPO = 'yankeguo/dsh-xcode-mcp'
const STAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u
/** Release tags are refs: no spaces, no leading dash (gh would read it as a flag). */
const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u

class UsageError extends Error {}
class PromoteError extends Error {}

const usage = `Promote the already-staged release of ${PACKAGE_NAME}: approve the staged npm version and create the GitHub Release.

Usage: node scripts/promote-release.mjs [options]

Options:
  --version <x.y.z>    Release version. Default: root package.json version.
  --release-tag <tag>  GitHub Release tag. Default: v<version>. The tag must
                       already exist on the remote; this script never creates,
                       moves, or deletes tags.
  --repo <owner/repo>  GitHub repository. Default: the origin git remote,
                       falling back to ${DEFAULT_REPO}.
  --notes-file <path>  Release notes file. Default: docs/releases/v<version>.md
                       (relative paths resolve from the repository root).
  --dry-run            Run the complete read-only preflight (staged state,
                       npm login, gh auth, existing remote tag, notes file) and
                       print the approve/release plan; approve nothing and
                       create no release.
  --list-only          Print the staged state of the package and exit. Used for
                       inspection/repair; no gh or notes checks, never mutates.
  -h, --help           Show this help.

Prerequisites:
  - npm >= 11.15.0 (this repo pins 11.20.0) and an interactive login with 2FA enabled:
      npm install -g npm@11.20.0 && npm login
    Approval prompts for the one-time password; the CI OIDC token can only stage.
  - gh >= 2.0 authenticated (gh auth status) with access to the repository.
  - The release notes file and the release tag already exist (you push the
    tag; neither CI nor this script creates it).

Typical use:
  node scripts/promote-release.mjs --dry-run           # inspect the plan
  node scripts/promote-release.mjs --version 0.1.0     # approve + release
`

/**
 * Parse argv, rejecting unknown/malformed flags (exit code 2).
 * @param {string[]} argv
 * @returns {{version: string | null, releaseTag: string | null, repo: string | null, notesFile: string | null, dryRun: boolean, listOnly: boolean}}
 */
function parseArgs (argv) {
  const options = { version: null, releaseTag: null, repo: null, notesFile: null, dryRun: false, listOnly: false }
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index]
    // Tolerate the conventional end-of-options marker so `pnpm release:* -- --flag`
    // and `npm run release:* -- --flag` work; this CLI takes no positional args.
    if (raw === '--') continue
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1
    const flag = eq === -1 ? raw : raw.slice(0, eq)
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1)
    const takeValue = (name) => {
      const value = inlineValue ?? argv[index + 1]
      if (typeof value !== 'string' || value === '' || (inlineValue === undefined && value.startsWith('--'))) {
        throw new UsageError(`${name} needs a value`)
      }
      if (inlineValue === undefined) index++
      return value
    }
    switch (flag) {
      case '-h':
      case '--help':
        process.stdout.write(usage)
        process.exit(0)
        break
      case '--version':
        options.version = takeValue('--version')
        if (!VERSION_PATTERN.test(options.version)) throw new UsageError(`--version must be a semver version such as 0.1.0 (got ${options.version})`)
        break
      case '--release-tag':
        options.releaseTag = takeValue('--release-tag')
        if (!TAG_PATTERN.test(options.releaseTag)) throw new UsageError(`--release-tag must be a valid git ref name (got ${options.releaseTag})`)
        break
      case '--repo':
        options.repo = takeValue('--repo')
        if (!REPO_PATTERN.test(options.repo)) throw new UsageError(`--repo must be owner/repository (got ${options.repo})`)
        break
      case '--notes-file':
        options.notesFile = takeValue('--notes-file')
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--list-only':
        options.listOnly = true
        break
      default:
        throw new UsageError(`unknown argument: ${raw}`)
    }
  }
  if (options.dryRun && options.listOnly) throw new UsageError('--dry-run and --list-only are mutually exclusive')
  return options
}

/**
 * Read and parse a JSON file with a contextual error message.
 * @param {string} filePath
 * @returns {any}
 */
function readJson (filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new PromoteError(`cannot read ${filePath}: ${error.message}`)
  }
}

/**
 * Run one command without throwing, so callers can classify failures.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd: string, stdio?: 'pipe' | 'inherit'}} options
 * @returns {{status: number | null, stdout: string, stderr: string, error?: Error}}
 */
function run (command, args, options) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
}

/**
 * @param {{status: number | null, error?: Error}} result
 * @param {string} command
 */
function assertSpawned (result, command) {
  if (result.error?.code === 'ENOENT') throw new PromoteError(`'${command}' was not found on PATH; install it and retry`)
  if (result.error) throw new PromoteError(`failed to run '${command}': ${result.error.message}`)
}

/**
 * @param {string} text
 * @param {number} lines
 * @returns {string}
 */
function tail (text, lines = 12) {
  return text.trim().split('\n').slice(-lines).join('\n')
}

/**
 * Derive the GitHub repository from the origin remote, validate --repo, or
 * fall back to the known repository when no GitHub origin exists yet.
 * @param {string | null} explicit
 * @param {string} cwd
 * @returns {string}
 */
function resolveRepo (explicit, cwd) {
  if (explicit) return explicit
  const result = run('git', ['remote', 'get-url', 'origin'], { cwd })
  if (!result.error && result.status === 0) {
    const url = result.stdout.trim()
    const match = url.match(/github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/u)
    if (match) return `${match[1]}/${match[2]}`
    console.warn(`warning: origin remote ${JSON.stringify(url)} is not a GitHub URL; using ${DEFAULT_REPO} (override with --repo)`)
    return DEFAULT_REPO
  }
  console.warn(`warning: no "origin" git remote; using ${DEFAULT_REPO} (override with --repo)`)
  return DEFAULT_REPO
}

/**
 * Resolve the release notes path (relative paths are repository-relative) and
 * require it to be a readable regular non-empty file.
 * @param {string | null} explicit
 * @param {string} version
 * @returns {string} absolute path
 */
function resolveNotesFile (explicit, version) {
  const candidate = explicit ?? join('docs', 'releases', `v${version}.md`)
  const absolute = isAbsolute(candidate) ? candidate : resolve(ROOT, candidate)
  if (!existsSync(absolute)) {
    throw new PromoteError(`release notes file not found: ${absolute}\nWrite the release notes before promoting (or pass --notes-file <path>).`)
  }
  let stat
  try {
    stat = statSync(absolute)
  } catch (error) {
    throw new PromoteError(`cannot read release notes ${absolute}: ${error.message}`)
  }
  if (!stat.isFile()) throw new PromoteError(`release notes path is not a regular file: ${absolute}`)
  if (stat.size === 0) throw new PromoteError(`release notes file is empty: ${absolute}`)
  return absolute
}

/**
 * Verify npm is new enough and logged in; the OIDC identity used by CI cannot
 * list or approve staged versions.
 * @param {string} neutralDir
 */
function checkNpm (neutralDir) {
  const version = run('npm', ['--version'], { cwd: neutralDir })
  assertSpawned(version, 'npm')
  if (version.status !== 0) throw new PromoteError(`'npm --version' failed (exit ${version.status})`)
  const stage = run('npm', ['stage', '--help'], { cwd: neutralDir })
  if (stage.status !== 0) {
    throw new PromoteError(
      `this npm does not implement staged publishing (npm stage --help failed; npm ${version.stdout.trim()}).\n` +
      'npm >= 11.15.0 is required: npm install -g npm@11.20.0'
    )
  }
  const whoami = run('npm', ['whoami'], { cwd: neutralDir })
  if (whoami.status !== 0) {
    const detail = tail(whoami.stderr || whoami.stdout, 4)
    throw new PromoteError(
      `npm is not logged in (npm ${version.stdout.trim()}).\nRun "npm login" as an @yankeguo maintainer, then retry. ` +
      'Approving staged versions requires a human login with 2FA; the CI OIDC token can only stage, never approve.' +
      (detail ? `\n${detail}` : '')
    )
  }
  return { npmVersion: version.stdout.trim(), user: whoami.stdout.trim() }
}

/**
 * Verify gh is installed, authenticated, has the repository, and the release
 * tag already exists on the remote (this script never creates/moves tags).
 * @param {string} repo
 * @param {string} tag
 * @param {string} neutralDir
 * @returns {{releaseExists: boolean}}
 */
function checkGh (repo, tag, neutralDir) {
  const version = run('gh', ['--version'], { cwd: neutralDir })
  assertSpawned(version, 'gh')
  if (version.status !== 0) throw new PromoteError(`'gh --version' failed (exit ${version.status})`)
  const auth = run('gh', ['auth', 'status'], { cwd: neutralDir })
  if (auth.status !== 0) {
    throw new PromoteError(
      `gh is not authenticated (gh auth status failed).\nRun "gh auth login" with access to ${repo}, then retry.\n` +
      tail(auth.stderr || auth.stdout, 6)
    )
  }
  const repoAccess = run('gh', ['api', `repos/${repo}`], { cwd: neutralDir })
  if (repoAccess.status !== 0) {
    throw new PromoteError(
      `the gh login cannot access ${repo} (gh api repos/${repo} failed):\n${tail(repoAccess.stderr || repoAccess.stdout, 6)}`
    )
  }
  const tagRef = run('gh', ['api', `repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`], { cwd: neutralDir })
  if (tagRef.status !== 0) {
    const detail = tail(tagRef.stderr || tagRef.stdout, 6)
    if (/not found|HTTP 404/iu.test(detail)) {
      throw new PromoteError(
        `release tag ${tag} does not exist on ${repo}.\n` +
        'Push the existing release tag first; this script never creates or moves tags. ' +
        `If the tag has not been pushed yet: git push origin ${tag}`
      )
    }
    throw new PromoteError(`cannot verify release tag ${tag} on ${repo}:\n${detail}`)
  }
  const release = run('gh', ['release', 'view', tag, '--repo', repo], { cwd: neutralDir })
  if (release.status === 0) return { releaseExists: true }
  const detail = tail(release.stderr || release.stdout, 6)
  if (/release not found|HTTP 404|Not Found/iu.test(detail)) return { releaseExists: false }
  throw new PromoteError(`cannot determine whether GitHub Release ${tag} exists:\n${detail}`)
}

/**
 * List the staged records visible to the logged-in npm user for the package,
 * filtered to the expected version. `npm stage list --json` prints an array of
 * records with id/packageName/version/tag/status/createdAt/actor/shasum.
 * @param {string} name
 * @param {string} expectedVersion
 * @param {string} neutralDir
 * @returns {Array<{id: string, packageName?: string, version?: string, tag?: string, createdAt?: string, actor?: string, shasum?: string}>}
 */
function listStaged (name, expectedVersion, neutralDir) {
  const result = run('npm', ['stage', 'list', name, '--json'], { cwd: neutralDir })
  assertSpawned(result, 'npm')
  if (result.status !== 0) {
    const stdout = result.stdout.trim()
    try {
      const parsed = JSON.parse(stdout)
      if (parsed?.error) {
        throw new PromoteError(
          `npm stage list failed for ${name}: ${parsed.error.code ?? ''} ${parsed.error.summary ?? ''}\n` +
          (parsed.error.code === 'ENEEDAUTH' ? 'Run "npm login" and retry.' : '')
        )
      }
    } catch (error) {
      if (error instanceof PromoteError) throw error
    }
    throw new PromoteError(`npm stage list failed for ${name} (exit ${result.status}):\n${tail(result.stderr || stdout)}`)
  }
  let items
  try {
    items = JSON.parse(result.stdout)
  } catch {
    throw new PromoteError(`npm stage list for ${name} did not print JSON:\n${tail(result.stdout)}`)
  }
  if (!Array.isArray(items)) throw new PromoteError(`npm stage list for ${name} printed an unexpected JSON shape`)
  return items.filter(item => item?.packageName === name && item?.version === expectedVersion)
}

/**
 * Whether <name>@<version> already exists on the registry (idempotent retry).
 * A just-approved version can take a moment to become visible through the
 * registry read path, and its staged record is already gone; retry briefly
 * before concluding that a version was never staged or published.
 * @param {string} name
 * @param {string} expectedVersion
 * @param {string} neutralDir
 * @returns {boolean}
 */
function isPublished (name, expectedVersion, neutralDir) {
  const attempts = 4
  for (let attempt = 1; ; attempt++) {
    const result = run('npm', ['view', `${name}@${expectedVersion}`, 'version', '--json'], { cwd: neutralDir })
    assertSpawned(result, 'npm')
    if (result.status === 0) return true
    const detail = result.stderr || result.stdout
    const missing = /E404|404 Not Found|is not in this registry/iu.test(detail)
    if (!missing) {
      throw new PromoteError(
        `cannot determine whether ${name}@${expectedVersion} is already published (npm view failed):\n${tail(detail)}`
      )
    }
    if (attempt >= attempts) return false
    // Registry reads can lag a just-approved version; give propagation a moment.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500)
  }
}

/**
 * Classify the package for preflight.
 * @param {{name: string, version: string}} pkg
 * @param {string} expectedVersion
 * @param {string} neutralDir
 * @returns {{status: 'staged', pkg: any, stageId: string, item: any} | {status: 'published', pkg: any} | {status: 'missing', pkg: any} | {status: 'duplicate', pkg: any, items: any[]}}
 */
function preflightPackage (pkg, expectedVersion, neutralDir) {
  const items = listStaged(pkg.name, expectedVersion, neutralDir)
  if (items.length === 1) {
    const stageId = items[0].id
    if (typeof stageId !== 'string' || !STAGE_ID_PATTERN.test(stageId)) {
      throw new PromoteError(
        `npm stage list returned a non-UUID id for ${pkg.name}@${expectedVersion}: ${JSON.stringify(stageId)}.\n` +
        'Staged publishing requires npm >= 11.15.0: npm install -g npm@11.20.0'
      )
    }
    return { status: 'staged', pkg, stageId, item: items[0] }
  }
  if (items.length > 1) return { status: 'duplicate', pkg, items }
  if (isPublished(pkg.name, expectedVersion, neutralDir)) return { status: 'published', pkg }
  return { status: 'missing', pkg }
}

/**
 * Approve one staged id with inherited stdio so npm can prompt for the OTP.
 * @param {string} stageId
 * @param {string} neutralDir
 */
function approveStage (stageId, neutralDir) {
  const result = run('npm', ['stage', 'approve', stageId], { cwd: neutralDir, stdio: 'inherit' })
  assertSpawned(result, 'npm')
  return result.status
}

/**
 * Idempotently create or update the GitHub Release for an existing tag.
 * Prerelease versions are marked --prerelease (and --latest=false on create);
 * edits of stable releases pass --prerelease=false so a stale prerelease flag
 * cannot survive an idempotent re-run.
 * @param {{repo: string, tag: string, notesFile: string, neutralDir: string, releaseExists: boolean, version: string, prerelease: boolean}} options
 * @returns {'created' | 'updated'}
 */
function ensureRelease (options) {
  const { repo, tag, notesFile, neutralDir, releaseExists, prerelease } = options
  const args = releaseExists
    ? ['release', 'edit', tag, '--repo', repo, '--title', tag, '--notes-file', notesFile, '--verify-tag', prerelease ? '--prerelease' : '--prerelease=false']
    : ['release', 'create', tag, '--repo', repo, '--title', tag, '--notes-file', notesFile, '--verify-tag', ...(prerelease ? ['--prerelease', '--latest=false'] : [])]
  const result = run('gh', args, { cwd: neutralDir, stdio: 'inherit' })
  assertSpawned(result, 'gh')
  if (result.status !== 0) {
    throw new PromoteError(
      `gh release ${releaseExists ? 'edit' : 'create'} ${tag} failed (exit ${result.status}).\n` +
      `The package is published; the release is the only missing piece. Fix the cause and re-run:\n` +
      `  node scripts/promote-release.mjs --version ${options.version}`
    )
  }
  return releaseExists ? 'updated' : 'created'
}

/**
 * Print the phase-1 plan in human-readable form.
 * @param {Array<any>} results
 * @param {{version: string, tag: string, repo: string, notesFile: string, releaseExists: boolean, prerelease: boolean}} context
 */
function printPlan (results, context) {
  console.log('')
  console.log(`Plan for ${context.version} (tag ${context.tag}, repo ${context.repo}):`)
  let step = 0
  for (const result of results) {
    if (result.status === 'staged') {
      step++
      const item = result.item ?? {}
      console.log(`  ${step}. approve ${result.pkg.name}@${context.version}  stageId=${result.stageId}${item.tag ? ` (dist-tag ${item.tag})` : ''}`)
    } else if (result.status === 'published') {
      console.log(`  - skip ${result.pkg.name}@${context.version}: already published (idempotent retry)`)
    }
  }
  step++
  const releaseMark = context.prerelease ? ' (--verify-tag, marked prerelease, not latest)' : ' (--verify-tag)'
  console.log(`  ${step}. ${context.releaseExists ? 'update' : 'create'} GitHub Release ${context.tag} from ${context.notesFile.replace(`${ROOT}/`, '')}${releaseMark}`)
}

/**
 * Print staged state for --list-only.
 * @param {Array<any>} results
 * @param {string} version
 */
function printStagedState (results, version) {
  console.log(`staged state for release ${version}:`)
  for (const result of results) {
    if (result.status === 'staged') {
      const item = result.item ?? {}
      const details = [item.tag ? `dist-tag ${item.tag}` : null, item.createdAt ? `created ${item.createdAt}` : null, item.actor ? `by ${item.actor}` : null]
        .filter(Boolean).join(', ')
      console.log(`  staged    ${result.pkg.name}@${version}  id=${result.stageId}${details ? `  (${details})` : ''}`)
    } else if (result.status === 'published') {
      console.log(`  published ${result.pkg.name}@${version}  (nothing left to approve)`)
    } else if (result.status === 'duplicate') {
      console.log(`  DUPLICATE ${result.pkg.name}@${version}  ${result.items.length} staged records:`)
      for (const item of result.items) console.log(`              id=${item.id}${item.createdAt ? ` created ${item.createdAt}` : ''}${item.shasum ? ` shasum ${item.shasum}` : ''}`)
    } else {
      console.log(`  MISSING   ${result.pkg.name}@${version}  (not staged and not published)`)
    }
  }
}

/**
 * Print the actionable state after a failure.
 * @param {string} message
 * @param {Array<any>} results
 * @param {Array<{name: string, version: string, stageId: string}>} approved
 * @param {string} version
 */
function reportFailure (message, results, approved, version) {
  console.error('')
  console.error(`promote-release failed: ${message}`)
  console.error('')
  if (approved.length > 0) {
    console.error('The package was approved and is now PUBLIC:')
    for (const item of approved) console.error(`  - ${item.name}@${item.version}`)
    console.error('')
  }
  const remaining = results.filter(result =>
    result.status === 'staged' && !approved.some(item => item.name === result.pkg.name))
  if (remaining.length > 0) {
    console.error('Still staged and not approved (approve it after fixing the failure):')
    for (const result of remaining) {
      console.error(`  - ${result.pkg.name}@${version}  stageId=${result.stageId}`)
      console.error(`      npm stage approve ${result.stageId}    # or: npm stage reject ${result.stageId}`)
    }
    console.error('')
  }
  const missing = results.filter(result => result.status === 'missing')
  if (missing.length > 0) {
    console.error('Missing staged version (re-run the publish workflow with workflow_dispatch and the SAME existing release_tag):')
    for (const result of missing) console.error(`  - ${result.pkg.name}@${version}`)
    console.error('')
  }
  console.error('Repair hints:')
  console.error(`  - inspect:  npm stage list ${PACKAGE_NAME} --json`)
  console.error('  - retry this script (it skips a version that was already approved/published):')
  console.error(`      node scripts/promote-release.mjs --version ${version}`)
  console.error('  - rejecting a staged version removes its staged tarball permanently and cannot be undone:')
  console.error('      npm stage reject <stage-id>')
  console.error('  - no GitHub Release was created or updated by a failed run.')
}

/**
 * Entry point.
 * @returns {number} process exit code
 */
function main () {
  /** @type {{version: string | null, releaseTag: string | null, repo: string | null, notesFile: string | null, dryRun: boolean, listOnly: boolean}} */
  let options = { version: null, releaseTag: null, repo: null, notesFile: null, dryRun: false, listOnly: false }
  /** @type {string} */
  let resolvedVersion = '(unknown)'
  /** @type {Array<{name: string, version: string, stageId: string}>} */
  const approved = []
  /** @type {Array<any>} */
  let results = []
  /** @type {string | null} */
  let workDir = null
  try {
    options = parseArgs(process.argv.slice(2))
    const manifest = readJson(join(ROOT, 'package.json'))
    if (manifest.name !== PACKAGE_NAME) {
      throw new PromoteError(`package.json name is ${JSON.stringify(manifest.name)}, expected ${PACKAGE_NAME}`)
    }
    if (manifest.private === true) {
      throw new PromoteError('package.json is "private": true; the publish form must remove it (see docs/PUBLISHING.md)')
    }
    const version = options.version ?? String(manifest.version ?? '')
    resolvedVersion = version
    if (!VERSION_PATTERN.test(version)) throw new PromoteError(`cannot determine a valid release version (package.json version is ${JSON.stringify(manifest.version)})`)
    if (manifest.version !== version) {
      throw new PromoteError(`package.json is version ${manifest.version}, but --version says ${version}; promote exactly the version that was staged`)
    }
    const tag = options.releaseTag ?? `v${version}`
    // Prerelease versions (-rc.N etc.) get a GitHub Release marked prerelease;
    // the npm dist-tag itself was recorded at stage/publish time (next).
    const prerelease = version.includes('-')
    const pkg = { name: manifest.name, version }

    // Neutral directory: npm must not read the repository's pnpm-only .npmrc.
    workDir = mkdtempSync(join(tmpdir(), 'dsh-xcode-mcp-promote-'))
    const neutralDir = workDir
    const repo = resolveRepo(options.repo, ROOT)
    const npmState = checkNpm(neutralDir)

    console.log(options.listOnly
      ? `promote-release: LIST ONLY — version ${version}`
      : `promote-release: version ${version}${prerelease ? ' (prerelease)' : ''}, tag ${tag}, repo ${repo}`)
    console.log(`npm ${npmState.npmVersion} as ${npmState.user}`)
    console.log('')

    console.log(`Preflight: matching one staged id for ${pkg.name}@${version} ...`)
    results = [preflightPackage(pkg, version, neutralDir)]

    if (options.listOnly) {
      printStagedState(results, version)
      const stagedCount = results.filter(result => result.status === 'staged').length
      const publishedCount = results.filter(result => result.status === 'published').length
      const missingCount = results.filter(result => result.status === 'missing').length
      const duplicateCount = results.filter(result => result.status === 'duplicate').length
      console.log('')
      console.log(`${stagedCount} staged, ${publishedCount} already published, ${missingCount} missing, ${duplicateCount} with duplicate records.`)
      return stagedCount + publishedCount === 1 ? 0 : 1
    }

    const duplicates = results.filter(result => result.status === 'duplicate')
    if (duplicates.length > 0) {
      const lines = duplicates.map(result =>
        `${result.pkg.name}@${version} has ${result.items.length} staged records:\n` +
        result.items.map(item => `    id=${item.id}${item.createdAt ? ` created ${item.createdAt}` : ''}${item.actor ? ` by ${item.actor}` : ''}${item.shasum ? ` shasum ${item.shasum}` : ''}`).join('\n')
      ).join('\n')
      throw new PromoteError(
        `${lines}\nExactly one staged record is required.\n` +
        'Inspect them (npm stage view <id> --json), then reject the stale record(s): npm stage reject <id>, ' +
        'and re-run the publish workflow with the same release_tag if a fresh stage is needed.'
      )
    }

    const missing = results.filter(result => result.status === 'missing')
    if (missing.length > 0) {
      throw new PromoteError(
        `no staged version and no published version for: ${missing.map(result => `${result.pkg.name}@${version}`).join(', ')}.\n` +
        'Run the publish workflow first (push a release tag, or workflow_dispatch with an existing release_tag); ' +
        'it stages the package. Nothing was approved.'
      )
    }

    const notesFile = resolveNotesFile(options.notesFile, version)
    const ghState = checkGh(repo, tag, neutralDir)
    const localTag = run('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { cwd: ROOT })
    if (localTag.status === 0) {
      const head = run('git', ['rev-parse', 'HEAD'], { cwd: ROOT })
      if (head.status === 0 && head.stdout.trim() !== localTag.stdout.trim()) {
        console.warn(`warning: local checkout HEAD (${head.stdout.trim().slice(0, 12)}) is not the ${tag} commit (${localTag.stdout.trim().slice(0, 12)}).`)
        console.warn('         Promotion reads the registry and release notes, not the built artifacts, so this is usually fine.')
      }
    }

    printPlan(results, { version, tag, repo, notesFile, releaseExists: ghState.releaseExists, prerelease })
    if (options.dryRun) {
      console.log('')
      console.log('DRY RUN: nothing was approved and no GitHub Release was created or updated.')
      return 0
    }

    const toApprove = results.filter(result => result.status === 'staged')
    if (toApprove.length > 0) {
      console.log('')
      console.log('Approving the staged package. npm will prompt for your one-time password;')
      console.log('the approval publishes it immediately and cannot be undone.')
    }
    for (const [index, result] of toApprove.entries()) {
      console.log('')
      console.log(`[${index + 1}/${toApprove.length}] npm stage approve ${result.stageId} (${result.pkg.name}@${version})`)
      const status = approveStage(result.stageId, neutralDir)
      if (status !== 0) {
        throw new PromoteError(
          `npm stage approve failed for ${result.pkg.name}@${version} (exit ${status}).\n` +
          'If npm reported EOTP/one-time password trouble, re-run and answer the prompt; ' +
          'if it reported an auth error, run npm login again.'
        )
      }
      approved.push({ name: result.pkg.name, version, stageId: result.stageId })
    }

    const releaseAction = ensureRelease({
      repo, tag, notesFile, neutralDir, releaseExists: ghState.releaseExists, version, prerelease,
    })
    console.log('')
    console.log(`GitHub Release ${tag} ${releaseAction}.`)
    console.log('')
    console.log('Release complete. Verify with:')
    console.log(`  npm view ${pkg.name}@${version} version dist-tags`)
    console.log(`  gh release view ${tag} --repo ${repo}`)
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`promote-release: ${error.message}\nRun with --help for usage.`)
      return 2
    }
    if (error instanceof PromoteError) {
      reportFailure(error.message, results, approved, resolvedVersion)
      return 1
    }
    reportFailure(error?.stack ?? String(error), results, approved, resolvedVersion)
    return 1
  } finally {
    if (workDir !== null) {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch (error) {
        console.warn(`warning: could not remove temporary directory ${workDir}: ${error.message}`)
      }
    }
  }
}

process.exitCode = main()
