#!/usr/bin/env node
/**
 * Stage the one publishable package of this repository (@yankeguo/dsh-xcode-mcp,
 * the root package.json) for a release with `npm stage publish`, consuming a
 * pnpm-packed tarball.
 *
 * Why staged publishing: CI uploads the version to the npm registry but
 * publishes nothing. A maintainer later approves the staged version(s) in bulk
 * on npmjs.com (human login + 2FA, no local CLI); after approval a maintainer
 * or agent creates the GitHub Release manually. A broken tarball is never
 * visible to users, and a compromised workflow can at worst stage an unapproved
 * version.
 *
 * Why pnpm pack: this single package has no `workspace:` dependencies, but the
 * release toolchain stays identical to the reference repos: pnpm packs, the npm
 * CLI stages (npm is the CLI that implements staged publishing, OIDC trusted
 * publishing, and provenance). In CI this must run with
 * `permissions: id-token: write`; locally the npm CLI needs `npm login`
 * (and OIDC/provenance are off).
 *
 * Guarantees:
 *   - validates that --version (or the root version) matches package.json,
 *   - refuses to stage a private manifest or one without fresh build output
 *     (lib/ is gitignored; every release must build first),
 *   - asserts the packed manifest has the expected name/version, no
 *     "workspace:" protocol, and every published key file inside the tarball
 *     (lib/index.js, lib/index.d.ts, cordis.patch.yml, locale/en.json,
 *     locale/zh.json, icon.svg, LICENSE, README.md),
 *   - asserts no source/test/release-script files leak into the tarball,
 *   - stops at the first failure, prints the real stage id (if any) and how to
 *     repair,
 *   - writes a staged-version table to stdout and, when GITHUB_STEP_SUMMARY is
 *     set, to the GitHub Actions job summary,
 *   - leaves the repository untouched (the tarball goes to a system temp dir
 *     that is removed afterwards).
 *
 * Usage:
 *   node scripts/stage-release.mjs [options]
 *
 * Options:
 *   --version <x.y.z>   Expected version (default: root package.json version).
 *   --dist-tag <tag>    npm dist-tag for the staged version. Default: latest
 *                       for stable versions, next for prereleases (-rc.N etc.).
 *                       A prerelease version with an explicit --dist-tag latest
 *                       is rejected: prereleases must never become latest.
 *   --dry-run           Pack and validate the tarball through the npm CLI
 *                       (`npm stage publish --dry-run --force`): uploads
 *                       nothing and creates no stage id. --force disables
 *                       npm's registry "already published" guard, so the
 *                       preflight also works for a version that already
 *                       exists; it does not verify registry state.
 *   --no-provenance     Do not pass --provenance to npm (which is otherwise
 *                       only passed inside GitHub Actions).
 *   -h, --help          Show this help.
 *
 * Requires: node >= 24.9, pnpm (12.16.1 in CI), npm >= 11.15.0 (`npm stage`;
 * the CI workflow pins 11.20.0), tar (GNU tar on GitHub-hosted Ubuntu, bsdtar
 * on macOS), and a fresh `pnpm build`.
 *
 * Exit codes: 0 staged (or dry-run OK), 1 staging/validation failure,
 * 2 invalid invocation.
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = '@yankeguo/dsh-xcode-mcp'
const ACCESS = 'public'
const STAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u
/** npm dist-tags must not look like a semver version and must be argv-safe. */
const DIST_TAG_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/u
/** Key files that must ship inside the tarball (package.json "files" contract). */
const REQUIRED_TARBALL_FILES = [
  'package/lib/index.js',
  'package/lib/index.d.ts',
  'package/cordis.patch.yml',
  'package/locale/en.json',
  'package/locale/zh.json',
  'package/icon.svg',
  'package/LICENSE',
  'package/README.md',
]
/** Nothing below these prefixes may ship (sources, tests, release tooling). */
const FORBIDDEN_TARBALL_PREFIXES = [
  'package/src/',
  'package/tests/',
  'package/scripts/',
  'package/node_modules/',
  'package/.git/',
]

class UsageError extends Error {}
class StageError extends Error {}

const usage = `Stage ${PACKAGE_NAME} for a release with npm staged publishing (publishes nothing).

Usage: node scripts/stage-release.mjs [options]

Options:
  --version <x.y.z>   Expected version. Default: the root package.json version.
  --dist-tag <tag>    npm dist-tag recorded with the staged version.
                      Default: latest for stable versions, next for
                      prereleases (-rc.N etc.). Must not look like a version.
                      Explicit 'latest' is rejected for prerelease versions.
  --dry-run           Pack and validate the tarball through the npm CLI
                      ('npm stage publish --dry-run --force'): uploads nothing,
                      creates no stage id. --force skips npm's registry
                      "already published" check, so this does not validate
                      registry state.
  --no-provenance     Do not pass --provenance even inside GitHub Actions.
  -h, --help          Show this help.

Environment:
  GITHUB_ACTIONS=true        Adds --provenance (npm also auto-enables it for
                             public packages from a public repository when the
                             OIDC token exchange succeeds).
  GITHUB_STEP_SUMMARY=<path> Appends the staged-version table to the job summary.

This script never publishes: it only stages. Approve the staged version on
npmjs.com (Staged packages / pending approvals page), then create the GitHub
Release manually with:
  gh release create <tag> --verify-tag --notes-file docs/releases/v<version>.md
(see docs/PUBLISHING.md).
`

/**
 * Parse process.argv into options, rejecting unknown/incomplete flags with
 * exit code 2.
 * @param {string[]} argv
 * @returns {{version: string | null, distTag: string, distTagExplicit: boolean, dryRun: boolean, noProvenance: boolean}}
 */
function parseArgs (argv) {
  const options = { version: null, distTag: 'latest', distTagExplicit: false, dryRun: false, noProvenance: false }
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index]
    // Tolerate the conventional end-of-options marker so `pnpm release:* -- --flag`
    // and `npm run release:* -- --flag` work; this CLI takes no positional args.
    if (raw === '--') continue
    const [flag, inlineValue] = raw.startsWith('--') && raw.includes('=')
      ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)]
      : [raw, undefined]
    const value = inlineValue ?? argv[index + 1]
    const takeValue = (name) => {
      if (typeof value !== 'string' || value === '' || (!inlineValue && value.startsWith('--'))) {
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
      case '--dist-tag':
        options.distTag = takeValue('--dist-tag')
        options.distTagExplicit = true
        if (!DIST_TAG_PATTERN.test(options.distTag)) throw new UsageError(`--dist-tag must match ${DIST_TAG_PATTERN} and not look like a version (got ${options.distTag})`)
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--no-provenance':
        options.noProvenance = true
        break
      default:
        throw new UsageError(`unknown argument: ${raw}`)
    }
  }
  return options
}

/**
 * Read and parse a JSON file with a contextual error message.
 * @param {string} filePath
 * @returns {any}
 */
function readJson (filePath) {
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new StageError(`cannot read ${filePath}: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new StageError(`${filePath} is not valid JSON: ${error.message}`)
  }
}

/**
 * Run one command, returning its exit status, stdout and stderr instead of
 * throwing, so callers can attach actionable context.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd: string}} options
 * @returns {{status: number | null, stdout: string, stderr: string, error?: Error}}
 */
function run (command, args, options) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  })
}

/**
 * Assert a command exists (spawn failed with ENOENT) and produce a friendly
 * install hint instead of a stack trace.
 * @param {{status: number | null, error?: Error}} result
 * @param {string} command
 */
function assertSpawned (result, command) {
  if (result.error?.code === 'ENOENT') {
    throw new StageError(`'${command}' was not found on PATH; install it before staging`)
  }
  if (result.error) throw new StageError(`failed to run '${command}': ${result.error.message}`)
}

/**
 * Best-effort short tail of a command's output for error messages.
 * @param {string} text
 * @param {number} lines
 * @returns {string}
 */
function tail (text, lines = 12) {
  return text.trim().split('\n').slice(-lines).join('\n')
}

/**
 * Pack the root package with pnpm into the tarball directory.
 * @param {string} packDir
 * @param {{name: string, version: string}} pkg
 * @returns {string} absolute tarball path
 */
function packPackage (packDir, pkg) {
  const result = run('pnpm', ['pack', '--pack-destination', packDir, '--json'], { cwd: ROOT })
  assertSpawned(result, 'pnpm')
  if (result.status !== 0) {
    throw new StageError(
      `pnpm pack failed for ${pkg.name} (exit ${result.status})\n${tail(result.stderr || result.stdout)}`
    )
  }
  let packed
  try {
    packed = JSON.parse(result.stdout)
  } catch {
    throw new StageError(`pnpm pack --json for ${pkg.name} did not print JSON:\n${tail(result.stdout)}`)
  }
  if (packed.name !== pkg.name) throw new StageError(`pnpm pack for ${pkg.name} packed unexpected package ${packed.name}`)
  if (packed.version !== pkg.version) throw new StageError(`pnpm pack for ${pkg.name} reported version ${packed.version}, expected ${pkg.version}`)
  const tarball = isAbsolute(packed.filename) ? packed.filename : resolve(ROOT, packed.filename)
  if (!existsSync(tarball)) throw new StageError(`pnpm pack for ${pkg.name} did not create ${tarball}`)
  return tarball
}

/**
 * Read package/package.json out of a packed tarball. Node has no tar parser in
 * its standard library, so this shells out to the system tar explicitly with an
 * argument array (no shell, no user-controlled interpolation).
 * @param {string} tarball
 * @returns {string} raw manifest text
 */
function readPackedManifestText (tarball) {
  const result = run('tar', ['-xzOf', tarball, 'package/package.json'], { cwd: dirname(tarball) })
  assertSpawned(result, 'tar')
  if (result.status !== 0) {
    throw new StageError(`cannot read package/package.json from ${tarball} (exit ${result.status}); GNU tar or bsdtar is required\n${tail(result.stderr)}`)
  }
  return result.stdout
}

/**
 * List every entry of a packed tarball (system tar, argument array).
 * @param {string} tarball
 * @returns {string[]} entry paths such as "package/lib/index.js"
 */
function listTarballEntries (tarball) {
  const result = run('tar', ['-tzf', tarball], { cwd: dirname(tarball) })
  assertSpawned(result, 'tar')
  if (result.status !== 0) {
    throw new StageError(`cannot list ${tarball} (exit ${result.status}); GNU tar or bsdtar is required\n${tail(result.stderr)}`)
  }
  return result.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
}

/**
 * Assert the packed tarball is what the release promises: expected name and
 * version, no workspace protocol, every key published file present, and no
 * source/test/release-tooling leakage.
 *
 * Locale metadata content is NOT re-validated here on purpose: the build and
 * scripts/check-packages.mjs already fail loudly when locale metadata drifts,
 * and duplicating that rule in the staging path would make a release fail for
 * a reason that is not about staging.
 *
 * @param {string} tarball
 * @param {{name: string, version: string}} pkg
 * @param {string} expectedVersion
 */
function assertPackedTarball (tarball, pkg, expectedVersion) {
  const text = readPackedManifestText(tarball)
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    throw new StageError(`packed manifest of ${pkg.name} is not valid JSON`)
  }
  if (manifest.name !== pkg.name) throw new StageError(`packed manifest of ${pkg.name} is named ${manifest.name}`)
  if (manifest.version !== expectedVersion) {
    throw new StageError(`packed ${pkg.name} has version ${manifest.version}, expected ${expectedVersion}; bump package.json before staging`)
  }
  if (text.includes('workspace:')) {
    throw new StageError(
      `packed ${pkg.name} still contains "workspace:" dependency specs.\n` +
      'This single-package repo must not declare workspace dependencies; pnpm pack would rewrite them, npm pack would not. ' +
      'Do not replace the pnpm pack step with npm pack/npm publish from the package directory.'
    )
  }
  const entries = new Set(listTarballEntries(tarball))
  const missing = REQUIRED_TARBALL_FILES.filter(file => !entries.has(file))
  if (missing.length > 0) {
    throw new StageError(
      `packed ${pkg.name} is missing key files: ${missing.join(', ')}.\n` +
      'Check package.json "files" and run "pnpm build" (lib/ is gitignored and must be built fresh before packing).'
    )
  }
  const leaked = [...entries].filter(entry => FORBIDDEN_TARBALL_PREFIXES.some(prefix => entry.startsWith(prefix)))
  if (leaked.length > 0) {
    throw new StageError(
      `packed ${pkg.name} ships files that must not be published: ${leaked.slice(0, 10).join(', ')}${leaked.length > 10 ? ', ...' : ''}.\n` +
      'package.json "files" is a whitelist; remove the offending entries or fix the pack configuration.'
    )
  }
}

/**
 * Stage the packed tarball with the npm CLI and return its stage id.
 * @param {string} tarball
 * @param {{name: string, version: string}} pkg
 * @param {{distTag: string, dryRun: boolean, provenance: boolean}} options
 * @param {string} neutralDir directory with no repo .npmrc, so npm does not warn about pnpm-only keys
 * @returns {{stageId: string | null, fileCount: number}}
 */
function stagePackage (tarball, pkg, options, neutralDir) {
  const args = ['stage', 'publish', tarball, '--access', ACCESS, '--tag', options.distTag, '--json']
  if (options.dryRun) {
    // --dry-run alone still performs the registry "already published" check, so
    // a version that was already staged/published would fail the local
    // preflight. --force suppresses that check; it is only used in dry-run.
    args.push('--dry-run', '--force')
  } else if (options.provenance) {
    args.push('--provenance')
  }
  const result = run('npm', args, { cwd: neutralDir })
  assertSpawned(result, 'npm')
  const stdout = result.stdout.trim()
  let parsed = null
  try {
    parsed = stdout === '' ? null : JSON.parse(stdout)
  } catch {
    parsed = null
  }
  if (parsed && Object.hasOwn(parsed, 'error')) {
    const { code, summary, detail } = parsed.error ?? {}
    throw new StageError(
      `npm stage publish failed for ${pkg.name}: ${code ? `${code}: ` : ''}${summary ?? 'unknown error'}${detail ? `\n${detail}` : ''}` +
      (code === 'ENEEDAUTH' ? '\nNot logged in (or the CI OIDC exchange failed). Locally run npm login; in CI check id-token: write and the trusted publisher record (--allow-stage-publish).' : '')
    )
  }
  if (result.status !== 0) {
    throw new StageError(
      `npm stage publish failed for ${pkg.name} (exit ${result.status})\n${tail(result.stderr || result.stdout)}`
    )
  }
  if (parsed === null) {
    throw new StageError(`npm stage publish for ${pkg.name} did not print JSON; output:\n${tail(result.stdout || result.stderr)}`)
  }
  const entry = parsed[pkg.name]
  if (!entry || typeof entry !== 'object') {
    throw new StageError(`npm stage publish for ${pkg.name} printed JSON without a "${pkg.name}" entry:\n${tail(stdout)}`)
  }
  if (entry.version !== pkg.version) {
    throw new StageError(`npm stage publish for ${pkg.name} reported version ${entry.version}, expected ${pkg.version}`)
  }
  const fileCount = Array.isArray(entry.files) ? entry.files.length : 0
  if (options.dryRun) {
    return { stageId: null, fileCount }
  }
  if (typeof entry.stageId !== 'string' || !STAGE_ID_PATTERN.test(entry.stageId)) {
    throw new StageError(
      `npm stage publish for ${pkg.name} did not return a UUID stage id (got ${JSON.stringify(entry.stageId)}). ` +
      'Staged publishing requires npm >= 11.15.0; in CI the workflow pins npm 11.20.0.'
    )
  }
  return { stageId: entry.stageId, fileCount }
}

/**
 * Append Markdown to the GitHub Actions job summary when the runner provides
 * one.
 * @param {string} markdown
 */
function appendStepSummary (markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return
  try {
    appendFileSync(summaryPath, markdown)
  } catch (error) {
    console.warn(`warning: could not append to GITHUB_STEP_SUMMARY (${summaryPath}): ${error.message}`)
  }
}

/**
 * Print the staged-so-far state and the repair hints after a failure.
 * @param {string} version release version, or '(unknown)' when not resolved yet
 * @param {Array<{name: string, version: string, stageId: string}>} staged
 * @param {StageError} error
 */
function reportFailure (version, staged, error) {
  console.error('')
  console.error(`stage-release failed: ${error.message}`)
  console.error('')
  if (staged.length > 0) {
    console.error('The package was staged before the failure; nothing is public yet:')
    for (const item of staged) console.error(`  - ${item.name}@${item.version}  stageId=${item.stageId}`)
    console.error('')
    appendStepSummary(
      `## npm staged publish — ${version} (FAILED)\n\n` +
      'The package was staged before the failure; nothing is public.\n\n' +
      '| package | version | stage id |\n| --- | --- | --- |\n' +
      staged.map(item => `| \`${item.name}\` | ${item.version} | \`${item.stageId}\` |`).join('\n') + '\n'
    )
  } else {
    console.error('Nothing was staged by this run.')
    console.error('')
  }
  console.error('Repair hints:')
  console.error(`  - inspect the registry state:  npm stage list ${PACKAGE_NAME} --json`)
  console.error('  - inspect an existing stage:   npm stage view <stage-id> --json')
  console.error('  - reject a stale/duplicate stage id (irreversible, removes the staged tarball):')
  console.error('      npm stage reject <stage-id>')
  console.error('  - if the version is already fully staged, do NOT re-run staging; approve it')
  console.error('    on npmjs.com (Staged packages / pending approvals page)')
  console.error('  - to retry CI after a fix, re-run the publish workflow with workflow_dispatch and')
  console.error('    the SAME existing release_tag (never move or recreate the tag).')
  console.error('  - a version that is already published cannot be staged again: bump package.json')
  console.error('    and push a new tag instead.')
}

/**
 * Entry point.
 * @returns {number} process exit code
 */
function main () {
  /** @type {{version: string | null, distTag: string, distTagExplicit: boolean, dryRun: boolean, noProvenance: boolean}} */
  let options = { version: null, distTag: 'latest', distTagExplicit: false, dryRun: false, noProvenance: false }
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`stage-release: ${error.message}\nRun with --help for usage.`)
      return 2
    }
    throw error
  }
  /** @type {Array<{name: string, version: string, stageId: string}>} */
  const staged = []
  /** @type {string} release version once resolved, for failure reports */
  let resolvedVersion = options.version ?? '(unknown)'
  /** @type {string | null} */
  let workDir = null
  try {
    const manifest = readJson(join(ROOT, 'package.json'))
    if (manifest.name !== PACKAGE_NAME) {
      throw new StageError(`package.json name is ${JSON.stringify(manifest.name)}, expected ${PACKAGE_NAME}; this script stages only this repository's package`)
    }
    if (manifest.private === true) {
      throw new StageError('package.json is "private": true; remove it (publish form) before staging — see docs/PUBLISHING.md')
    }
    const expectedVersion = options.version ?? String(manifest.version ?? '')
    resolvedVersion = expectedVersion
    if (!VERSION_PATTERN.test(expectedVersion)) {
      throw new StageError(`cannot determine a valid release version (package.json version is ${JSON.stringify(manifest.version)})`)
    }
    if (manifest.version !== expectedVersion) {
      throw new StageError(`package.json is version ${manifest.version}, but --version says ${expectedVersion}; bump package.json (and sync the lockfile with pnpm install) first`)
    }
    const pkg = { name: manifest.name, version: expectedVersion }

    // Prerelease versions (-rc.N / -alpha.N / ...) must never become latest:
    // npm records the dist-tag at publish/approve time, and a prerelease staged
    // with latest would make `npm install <pkg>` resolve to it on approval.
    // Default them to next; an explicit --dist-tag latest is a hard error.
    const prerelease = expectedVersion.includes('-')
    if (prerelease && options.distTagExplicit && options.distTag === 'latest') {
      throw new StageError(
        `${pkg.name}@${expectedVersion} is a prerelease; --dist-tag latest is not allowed for prereleases.\n` +
        'Use --dist-tag next (the default for prerelease versions) so a stable release keeps owning latest.'
      )
    }
    if (prerelease && !options.distTagExplicit) options.distTag = 'next'

    // lib/ is gitignored: a release must pack freshly built output, never a
    // stale or absent lib/. The CI workflow and `pnpm release:dry` build first.
    for (const artifact of ['lib/index.js', 'lib/index.d.ts']) {
      if (!existsSync(join(ROOT, artifact))) {
        throw new StageError(`${artifact} is missing; run "pnpm build" before staging (lib/ is gitignored and must be built fresh for every release)`)
      }
    }

    // A neutral working directory keeps npm from reading this repository's
    // pnpm-only .npmrc (node-linker/auto-install-peers), which npm would report
    // as unknown project config.
    workDir = mkdtempSync(join(tmpdir(), 'dsh-xcode-mcp-stage-'))
    const neutralDir = workDir
    const packDir = join(workDir, 'packs')
    mkdirSync(packDir)

    const npmStage = run('npm', ['stage', '--help'], { cwd: neutralDir })
    assertSpawned(npmStage, 'npm')
    if (npmStage.status !== 0) {
      throw new StageError(
        'this npm does not implement staged publishing (npm stage --help failed). npm >= 11.15.0 is required; install it with: npm install -g npm@11.20.0 (CI pins npm 11.20.0)'
      )
    }
    const pnpmVersion = run('pnpm', ['--version'], { cwd: ROOT })
    assertSpawned(pnpmVersion, 'pnpm')
    if (pnpmVersion.status !== 0) throw new StageError('pnpm is required to pack the package; install pnpm 12.16.1 (`corepack enable`)')

    const provenance = process.env.GITHUB_ACTIONS === 'true' && !options.noProvenance
    const mode = options.dryRun ? 'DRY RUN (no upload)' : 'STAGE'
    console.log(`stage-release: ${mode} — ${pkg.name}@${expectedVersion}, dist-tag ${options.distTag}`)
    console.log(`npm ${(run('npm', ['--version'], { cwd: neutralDir }).stdout || '').trim()} / pnpm ${pnpmVersion.stdout.trim()}`)
    console.log(`provenance: ${provenance ? 'yes (--provenance, GitHub Actions)' : 'no'}`)
    console.log('')

    const tarball = packPackage(packDir, pkg)
    assertPackedTarball(tarball, pkg, expectedVersion)
    const result = stagePackage(tarball, pkg, {
      distTag: options.distTag,
      dryRun: options.dryRun,
      provenance,
    }, neutralDir)

    console.log('')
    if (options.dryRun) {
      console.log(`dry-run OK ${pkg.name}@${pkg.version} (${result.fileCount} files, ${tarball.split('/').pop()})`)
      console.log(`DRY RUN OK: packed and preflighted ${pkg.name}@${expectedVersion}; nothing was uploaded and no stage id was created.`)
      appendStepSummary(`## npm staged publish — ${expectedVersion} (dry run)\n\nDry run: packed and preflighted \`${pkg.name}\`, nothing was uploaded.\n`)
      return 0
    }
    staged.push({ name: pkg.name, version: pkg.version, stageId: result.stageId })
    console.log(`staged ${pkg.name}@${pkg.version} stageId=${result.stageId}`)
    console.log('')
    console.log(`STAGED ${pkg.name}@${expectedVersion}. NOTHING IS PUBLIC YET.`)
    console.log('')
    console.log('Next step (maintainer, npmjs.com web approval):')
    console.log('  1. sign in to https://www.npmjs.com and open the staged packages /')
    console.log(`     pending approvals page for ${pkg.name}; approve the staged version`)
    console.log(`     (dist-tag ${options.distTag}); approval publishes it immediately and`)
    console.log('     cannot be undone.')
    console.log('  2. after approval, create the GitHub Release manually (the tag already exists):')
    console.log(`     gh release create v${expectedVersion} --repo yankeguo/dsh-xcode-mcp \\`)
    console.log(`       --title v${expectedVersion} --notes-file docs/releases/v${expectedVersion}.md \\`)
    console.log(`       --verify-tag ${options.distTag === 'next' ? '--prerelease --latest=false' : '--latest'}`)
    appendStepSummary(
      `## npm staged publish — ${expectedVersion}\n\n` +
      `\`${pkg.name}\` staged. Nothing is public until a maintainer approves.\n\n` +
      '| package | version | stage id |\n| --- | --- | --- |\n' +
      `| \`${pkg.name}\` | ${pkg.version} | \`${result.stageId}\` |\n`
    )
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`stage-release: ${error.message}\nRun with --help for usage.`)
      return 2
    }
    if (error instanceof StageError) {
      reportFailure(resolvedVersion, staged, error)
      return 1
    }
    reportFailure(resolvedVersion, staged, new StageError(error?.stack ?? String(error)))
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
