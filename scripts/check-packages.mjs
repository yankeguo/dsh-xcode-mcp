#!/usr/bin/env node
/**
 * Validate the single-package publishing contract of @yankeguo/dsh-xcode-mcp
 * that the build itself cannot see:
 *
 *   - manifest identity and publish shape (name, semver version, not private,
 *     publishConfig.access=public, repository/homepage/bugs),
 *   - engines (exact engines.dsh compatibility range, engines.node present),
 *   - files/exports wiring (lib, cordis.patch.yml, locale/*.json, icon.svg,
 *     README.md, LICENSE; ".", "./locale/*.json", "./icon", "./package.json"),
 *   - DSH bundle contract (dsh.bundle.patch -> existing cordis.patch.yml,
 *     icon <= 256 KiB, locale/en.json + locale/zh.json display metadata),
 *   - DSH dependency placement (host packages are peers, never direct or
 *     optional dependencies; DSH peers are ranges, not exact rc pins; every
 *     peer is installed as a devDependency for typechecking),
 *   - build artifacts (lib/index.js + lib/index.d.ts; lib/ is gitignored, so a
 *     release must build fresh),
 *   - pnpm-lock.yaml consistency (root importer only, dependency specifiers
 *     match package.json both ways),
 *   - the pinned CI workflows and the staged-publishing contract (CI only
 *     stages; a maintainer approves the staged version(s) in bulk on npmjs.com;
 *     the GitHub Release is created manually with `gh release create
 *     --verify-tag`, never by CI, and the old local promote script is gone).
 *
 * Read-only, node stdlib only (no semver dependency: the official semver
 * pattern is inlined). Safe to run in CI after `pnpm build`; wired into both
 * verify.yml and publish.yml. Run:
 *
 *   node scripts/check-packages.mjs
 *
 * Exit codes: 0 all checks pass, 1 at least one failure, 2 invalid invocation.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The one publishable package of this repository (the root manifest). */
const PACKAGE_NAME = '@yankeguo/dsh-xcode-mcp'
const REPO = 'yankeguo/dsh-xcode-mcp'
const REPO_URL_PART = `github.com/${REPO}`
/** Exact DSH compatibility range this plugin is released against. */
const DSH_RANGE = '>=0.2.1-rc.1 <0.3.0'
/** Expected pinned toolchain used by every workflow (same as the reference repos). */
const PNPM_VERSION = '12.16.1'
const NODE_VERSION = '24'
const NPM_VERSION = '11.20.0'
const EXPECTED_ACTION_PINS = [
  'actions/checkout@v7.0.1',
  'actions/setup-node@v7.1.0',
  'pnpm/action-setup@v6.1.1',
]
/** Official semver 2.0.0 pattern (no leading zeros, optional prerelease/build). */
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u
/** DSH plugin-manager icon limit (readPluginMeta): <= 256 KiB. */
const ICON_MAX_BYTES = 256 * 1024
const REQUIRED_FILES = ['lib', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md', 'LICENSE']
const REQUIRED_EXPORTS = {
  '.': './lib/index.js',
  './locale/*.json': './locale/*.json',
  './icon': './icon.svg',
  './package.json': './package.json',
}
const LOCALE_LANGUAGES = ['en', 'zh']
/**
 * Display metadata must not use marketing superlatives (same convention as the
 * reference repos). ASCII entries match whole lowercase words, CJK entries
 * match substrings.
 */
const BANNED_SUPERLATIVES = [
  'best', 'world-class', 'powerful', 'seamless', 'seamlessly', 'ultimate',
  'leading', 'top-tier', 'cutting-edge', 'state-of-the-art', 'revolutionary',
  'game-changing', 'unmatched', 'effortless', 'supercharge', 'next-generation',
  'premier', '最佳', '最强', '最优', '最先进', '最高级', '最领先', '第一',
  '唯一', '极致', '顶级', '业界领先', '世界级',
]

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: node scripts/check-packages.mjs\n\nRead-only single-package publishing checks: manifest identity/publish shape, engines,\nfiles/exports, DSH bundle + locale metadata, dependency placement, build artifacts,\nlockfile consistency, CI workflow pins, and the staged-publishing contract.')
  process.exit(0)
}
if (argv.length > 0) {
  console.error(`check-packages: unknown argument: ${argv[0]}`)
  process.exit(2)
}

/** @type {Array<{label: string, ok: boolean, detail: string}>} */
const checks = []
/** @type {string[]} */
const notes = []

/**
 * Record one named check.
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail] failure explanation (what to change)
 */
function check (label, ok, detail = '') {
  checks.push({ label, ok, detail })
}

/**
 * Read and parse a JSON file, recording a failure instead of throwing.
 * @param {string} path
 * @param {string} label
 * @returns {any | null}
 */
function readJsonOrFailed (path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    check(label, false, `cannot read ${path}: ${error.message}`)
    return null
  }
}

/**
 * Report the first banned superlative in a display string.
 * @param {string} text
 * @returns {string | undefined}
 */
function bannedSuperlativeIn (text) {
  const lower = text.toLowerCase()
  for (const word of BANNED_SUPERLATIVES) {
    const ascii = /^[\x00-\x7F]+$/u.test(word)
    if (ascii ? new RegExp(`\\b${word}\\b`, 'u').test(lower) : lower.includes(word)) return word
  }
  return undefined
}

// ---- manifest identity and publish shape -----------------------------------
const manifest = readJsonOrFailed(join(ROOT, 'package.json'), 'package.json is readable JSON')
if (manifest === null) {
  report()
} else {
  check('name is @yankeguo/dsh-xcode-mcp', manifest.name === PACKAGE_NAME, `found ${JSON.stringify(manifest.name)}`)
  check('version is valid semver', typeof manifest.version === 'string' && SEMVER_PATTERN.test(manifest.version), `found ${JSON.stringify(manifest.version)}`)
  check('not private (publish form)', manifest.private !== true, 'remove "private": true from package.json before publishing')
  check('publishConfig.access is "public"', manifest.publishConfig?.access === 'public', 'add "publishConfig": { "access": "public" }')
  check('type is "module"', manifest.type === 'module', `found ${JSON.stringify(manifest.type)}`)
  for (const field of ['description', 'license']) {
    check(`${field} is a non-empty string`, typeof manifest[field] === 'string' && manifest[field].trim().length > 0, `found ${JSON.stringify(manifest[field])}`)
  }
  const repositoryUrl = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  check('repository points at github.com/yankeguo/dsh-xcode-mcp',
    typeof repositoryUrl === 'string' && repositoryUrl.includes(REPO_URL_PART),
    'add "repository": { "type": "git", "url": "git+https://github.com/yankeguo/dsh-xcode-mcp.git" }')
  check('homepage points at the repository',
    typeof manifest.homepage === 'string' && manifest.homepage.includes(REPO_URL_PART),
    'add "homepage": "https://github.com/yankeguo/dsh-xcode-mcp#readme"')
  check('bugs points at the repository issues',
    typeof manifest.bugs?.url === 'string' && manifest.bugs.url.includes(REPO_URL_PART),
    'add "bugs": { "url": "https://github.com/yankeguo/dsh-xcode-mcp/issues" }')

  // ---- engines --------------------------------------------------------------
  check(`engines.dsh is exactly "${DSH_RANGE}"`, manifest.engines?.dsh === DSH_RANGE, `found ${JSON.stringify(manifest.engines?.dsh)}; update the range only together with a compatibility regression`)
  check('engines.node is declared', typeof manifest.engines?.node === 'string' && manifest.engines.node.trim().length > 0, 'add "engines": { "node": ">=24.9" }')

  // ---- files / exports ------------------------------------------------------
  const files = Array.isArray(manifest.files) ? manifest.files : []
  for (const entry of REQUIRED_FILES) {
    check(`files includes "${entry}"`, files.includes(entry), `add "${entry}" to package.json "files"`)
  }
  for (const [subpath, target] of Object.entries(REQUIRED_EXPORTS)) {
    check(`exports["${subpath}"] is "${target}"`, manifest.exports?.[subpath] === target, `found ${JSON.stringify(manifest.exports?.[subpath])}`)
  }

  // ---- DSH bundle contract --------------------------------------------------
  const patch = manifest.dsh?.bundle?.patch
  const patchPath = typeof patch === 'string' ? resolve(ROOT, patch) : null
  check('dsh.bundle.patch points at an existing cordis.patch.yml',
    patchPath !== null && existsSync(patchPath) && patchPath === join(ROOT, 'cordis.patch.yml'),
    `found ${JSON.stringify(patch)}; expected "./cordis.patch.yml" resolving to an existing file`)
  const platforms = manifest.dsh?.bundle?.platforms
  check('dsh.bundle.platforms admits only macOS',
    Array.isArray(platforms) && platforms.length === 1 && platforms[0] === 'darwin',
    `found ${JSON.stringify(platforms)}; this bundle runs xcrun and only works on macOS`)
  const icon = manifest.icon
  const iconPath = typeof icon === 'string' ? resolve(ROOT, icon) : null
  check('icon field points at an existing icon.svg',
    iconPath !== null && existsSync(iconPath) && iconPath === join(ROOT, 'icon.svg'),
    `found ${JSON.stringify(icon)}; expected "./icon.svg"`)
  if (iconPath !== null && existsSync(iconPath)) {
    const size = statSync(iconPath).size
    check(`icon.svg is <= 256 KiB (DSH plugin-manager limit)`, size > 0 && size <= ICON_MAX_BYTES, `icon.svg is ${size} bytes`)
  } else {
    check('icon.svg is <= 256 KiB (DSH plugin-manager limit)', false, 'icon.svg is missing')
  }
  for (const file of ['LICENSE', 'README.md', 'cordis.patch.yml']) {
    const path = join(ROOT, file)
    const ok = existsSync(path) && statSync(path).isFile() && statSync(path).size > 0
    check(`${file} exists and is non-empty`, ok, `${file} is missing or empty; it is listed in "files" and must ship`)
  }

  // ---- locale display metadata ----------------------------------------------
  // The DSH plugin manager renders locale/<language>.json meta.title /
  // meta.description without executing plugin code, resolved through the
  // exports map; missing metadata silently falls back to name/description.
  for (const language of LOCALE_LANGUAGES) {
    const label = `locale/${language}.json`
    const parsed = readJsonOrFailed(join(ROOT, 'locale', `${language}.json`), `${label} is readable JSON`)
    if (parsed === null) continue
    const meta = parsed !== null && typeof parsed === 'object' ? parsed.meta : undefined
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
      check(`${label} has a "meta" object`, false, 'expected { "meta": { "title": ..., "description": ... } }')
      continue
    }
    check(`${label} has a "meta" object`, true)
    for (const field of ['title', 'description']) {
      const value = meta[field]
      const nonEmpty = typeof value === 'string' && value.trim().length > 0
      check(`${label} meta.${field} is a non-empty string`, nonEmpty, `found ${JSON.stringify(value)}`)
      if (nonEmpty) {
        const banned = bannedSuperlativeIn(value)
        check(`${label} meta.${field} uses no banned superlative`, banned === undefined, `uses "${banned}"`)
      }
    }
  }

  // ---- DSH dependency placement ---------------------------------------------
  // Host runtime packages must be peers (DSH linked-root resolution routes them
  // to the installation instance); a direct/optional dependency would install a
  // second physical copy. This plugin is pure TS: it ships no launcher script,
  // and its only runtime dependency is the `yaml` parser.
  const dependencies = manifest.dependencies ?? {}
  const optionalDependencies = manifest.optionalDependencies ?? {}
  const peers = manifest.peerDependencies ?? {}
  const devDependencies = manifest.devDependencies ?? {}
  for (const [section, entries] of [['dependencies', dependencies], ['optionalDependencies', optionalDependencies]]) {
    for (const name of Object.keys(entries)) {
      check(`${section} has no DSH host package (${name})`, !name.startsWith('@deepseek-ai/'), 'DSH packages must be peerDependencies (linked-root routing), never direct/optional dependencies')
    }
  }
  for (const [section, entries] of [['dependencies', dependencies], ['optionalDependencies', optionalDependencies], ['peerDependencies', peers]]) {
    for (const [name, spec] of Object.entries(entries)) {
      check(`${section} has no experimental package (${name})`, !name.includes('dsh-experimental'), 'experimental packages must not be declared')
      check(`${section} ${name} has no workspace: spec`, typeof spec === 'string' && !spec.startsWith('workspace:'), 'this single-package repo has no workspace dependencies')
    }
  }
  for (const [name, spec] of Object.entries(peers)) {
    if (name.startsWith('@deepseek-ai/dsh-')) {
      // An exact rc pin still loads (engines.dsh is decisive) but makes a
      // profile's pnpm peer check report unmet peers on every later rc.
      check(`DSH peer ${name} is a range, not an exact version`, typeof spec === 'string' && !SEMVER_PATTERN.test(spec), `found exact pin ${JSON.stringify(spec)}; use a range such as "${DSH_RANGE}"`)
    }
    check(`peer ${name} is installed as a devDependency (typecheck resolution)`, Object.hasOwn(devDependencies, name), `add ${name} to devDependencies`)
  }

  // ---- build artifacts --------------------------------------------------------
  for (const artifact of ['lib/index.js', 'lib/index.d.ts']) {
    check(`${artifact} exists (built)`, existsSync(join(ROOT, artifact)), 'run "pnpm build" first; lib/ is gitignored, so every release must build fresh')
  }

  // ---- root scripts wiring ----------------------------------------------------
  const scripts = manifest.scripts ?? {}
  for (const name of ['build', 'typecheck', 'test', 'verify']) {
    check(`scripts["${name}"] exists`, typeof scripts[name] === 'string' && scripts[name].length > 0, `add the "${name}" script`)
  }
  check('scripts["check:packages"] runs check-packages.mjs', typeof scripts['check:packages'] === 'string' && scripts['check:packages'].includes('check-packages.mjs'), 'add "check:packages": "node scripts/check-packages.mjs"')
  check('scripts["release:dry"] runs stage-release.mjs --dry-run',
    typeof scripts['release:dry'] === 'string' && scripts['release:dry'].includes('stage-release.mjs') && scripts['release:dry'].includes('--dry-run'),
    'add "release:dry": "pnpm build && node scripts/stage-release.mjs --dry-run"')
  check('scripts["release:stage"] runs stage-release.mjs', typeof scripts['release:stage'] === 'string' && scripts['release:stage'].includes('stage-release.mjs'), 'add "release:stage": "pnpm build && node scripts/stage-release.mjs"')
  check('no local promote script (release:promote removed)', scripts['release:promote'] === undefined, 'approval happens in bulk on npmjs.com and the GitHub Release is created manually; remove any "release:promote" script')
  check('no direct-publish script (release:publish)', scripts['release:publish'] === undefined, 'remove "release:publish"; CI stages and a maintainer approves, nobody publishes directly')

  // ---- lockfile consistency ---------------------------------------------------
  checkLockfile(manifest)
}

/**
 * Parse the pnpm-lock.yaml root importer with a small line-based reader (this
 * check stays stdlib-only; the runtime package's `yaml` dependency is unrelated
 * and must not be imported here). pnpm v9 lockfiles record
 * dependencies/devDependencies/optionalDependencies per importer;
 * peerDependencies are NOT recorded, so they are not compared.
 * @param {string} lockText
 * @returns {{importers: string[], sections: Record<string, Map<string, string>>} | null}
 */
function parseRootImporter (lockText) {
  const lines = lockText.split('\n')
  const start = lines.findIndex(line => line === 'importers:')
  if (start === -1) return null
  /** @type {string[]} */
  const importers = []
  /** @type {Record<string, Map<string, string>>} */
  const sections = {}
  let inRoot = false
  let section = null
  let pendingName = null
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]
    if (/^\S/u.test(line)) break // next top-level key (packages:, snapshots:, ...)
    const importerMatch = line.match(/^  (\S+):$/u)
    if (importerMatch) {
      importers.push(importerMatch[1])
      inRoot = importerMatch[1] === '.'
      section = null
      pendingName = null
      continue
    }
    if (!inRoot) continue
    const sectionMatch = line.match(/^    ([A-Za-z]+):$/u)
    if (sectionMatch) {
      section = sectionMatch[1]
      sections[section] ??= new Map()
      pendingName = null
      continue
    }
    const entryMatch = line.match(/^      (?:'([^']+)'|([^':\n]+)):\s*$/u)
    if (entryMatch && section) {
      pendingName = entryMatch[1] ?? entryMatch[2]
      continue
    }
    const specifierMatch = line.match(/^        specifier:\s*(.*)$/u)
    if (specifierMatch && section && pendingName !== null) {
      let spec = specifierMatch[1].trim()
      if ((spec.startsWith("'") && spec.endsWith("'")) || (spec.startsWith('"') && spec.endsWith('"'))) spec = spec.slice(1, -1)
      sections[section].set(pendingName, spec)
      pendingName = null
    }
  }
  return { importers, sections }
}

/**
 * Compare pnpm-lock.yaml against package.json: lockfile version, single root
 * importer, and dependency specifiers matching both ways.
 * @param {any} manifest
 */
function checkLockfile (manifest) {
  const lockPath = join(ROOT, 'pnpm-lock.yaml')
  if (!existsSync(lockPath)) {
    check('pnpm-lock.yaml exists', false, 'run "pnpm install" to create the lockfile')
    return
  }
  const lockText = readFileSync(lockPath, 'utf8')
  check("pnpm-lock.yaml lockfileVersion is '9.0'", /^lockfileVersion: '9\.0'$/mu.test(lockText), 'unexpected lockfileVersion; regenerate with pnpm 12.16.1')
  const parsed = parseRootImporter(lockText)
  if (parsed === null) {
    check('pnpm-lock.yaml has a root importer', false, 'missing importers block; run "pnpm install"')
    return
  }
  check('pnpm-lock.yaml has a root importer', parsed.importers.includes('.'), 'run "pnpm install"')
  check('pnpm-lock.yaml has only the root importer (single package)',
    parsed.importers.length === 1 && parsed.importers[0] === '.',
    `found importers: ${parsed.importers.join(', ')}; this repo publishes only the root package`)
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const manifestEntries = manifest[section] ?? {}
    const lockEntries = parsed.sections[section] ?? new Map()
    for (const [name, spec] of Object.entries(manifestEntries)) {
      const lockSpec = lockEntries.get(name)
      check(`lockfile ${section} ${name} matches package.json`, lockSpec === spec,
        lockSpec === undefined
          ? `missing from pnpm-lock.yaml; run "pnpm install" to sync the lockfile`
          : `lockfile specifier ${JSON.stringify(lockSpec)} != package.json ${JSON.stringify(spec)}; run "pnpm install"`)
    }
    for (const name of lockEntries.keys()) {
      check(`lockfile ${section} has no stale entry (${name})`, Object.hasOwn(manifestEntries, name), 'present in pnpm-lock.yaml but not in package.json; run "pnpm install"')
    }
  }
  notes.push('peerDependencies are not recorded in pnpm-lock.yaml importers (pnpm v9); they are checked against devDependencies instead')
}

// ---- repository files --------------------------------------------------------
for (const script of ['check-packages.mjs', 'stage-release.mjs', 'trusted-publishers.sh']) {
  check(`scripts/${script} exists`, existsSync(join(ROOT, 'scripts', script)), 'release tooling is missing')
}
check('scripts/promote-release.mjs is removed (web approval + manual GitHub Release)',
  !existsSync(join(ROOT, 'scripts', 'promote-release.mjs')),
  'delete scripts/promote-release.mjs; approval is done in bulk on npmjs.com and the GitHub Release is created manually')
const gitignorePath = join(ROOT, '.gitignore')
if (existsSync(gitignorePath)) {
  const patterns = readFileSync(gitignorePath, 'utf8').split('\n').map(line => line.trim())
  for (const pattern of ['node_modules/', 'lib/']) {
    check(`.gitignore ignores ${pattern}`, patterns.includes(pattern), `add "${pattern}" to .gitignore (build output must never be committed; releases build fresh)`)
  }
} else {
  check('.gitignore exists', false, 'missing .gitignore')
}

// ---- CI workflows and the staged-publishing contract -------------------------
const workflowDir = join(ROOT, '.github', 'workflows')
for (const workflow of ['publish.yml', 'verify.yml']) {
  check(`.github/workflows/${workflow} exists`, existsSync(join(workflowDir, workflow)), 'release/verify workflow is missing')
}
const readWorkflow = name => existsSync(join(workflowDir, name)) ? readFileSync(join(workflowDir, name), 'utf8') : ''
const publish = readWorkflow('publish.yml')
const verify = readWorkflow('verify.yml')

const pinsOf = text => [...text.matchAll(/uses:\s*(\S+@v[\w.]+)/gu)].map(match => match[1]).sort()
const publishPins = pinsOf(publish)
const verifyPins = pinsOf(verify)
check('workflows use identical pinned action versions',
  publishPins.length === verifyPins.length && publishPins.every((pin, index) => pin === verifyPins[index]),
  `publish: ${publishPins.join(', ')}; verify: ${verifyPins.join(', ')}`)
check(`workflows pin exactly ${EXPECTED_ACTION_PINS.join(', ')}`,
  publishPins.length === EXPECTED_ACTION_PINS.length && publishPins.every((pin, index) => pin === EXPECTED_ACTION_PINS[index]),
  `found ${publishPins.join(', ')}; third-party actions must stay pinned to the reference versions`)
for (const [name, text] of [['publish.yml', publish], ['verify.yml', verify]]) {
  check(`${name} pins pnpm ${PNPM_VERSION}`, text.includes(`version: ${PNPM_VERSION}`), `add "version: ${PNPM_VERSION}" to pnpm/action-setup`)
  check(`${name} pins Node ${NODE_VERSION}`, text.includes(`node-version: ${NODE_VERSION}`), `add "node-version: ${NODE_VERSION}" to actions/setup-node`)
}
// Executable lines only: comments legitimately mention "npm publish"/"git push"
// while explaining that the workflow must never run them.
const executable = text => text.split('\n').filter(line => !/^\s*#/u.test(line)).join('\n')
const publishExec = executable(publish)
const verifyExec = executable(verify)

check('publish.yml declares id-token: write (OIDC)', /id-token: write/u.test(publish), 'required for the npm OIDC token exchange when staging')
check('publish.yml declares contents: read', /permissions:\s*\n\s*contents: read/u.test(publish), 'CI must not need write access; the GitHub Release is created manually after approval')
check('publish.yml never requests contents: write', !/contents:\s*write/u.test(publish), 'the GitHub Release is created manually after approval, never by CI')
check('verify.yml is read-only (contents: read)', /permissions:\s*\n\s*contents: read/u.test(verify), 'verification must not mutate the repository')
check('verify.yml has no id-token permission', !/id-token:/u.test(verify), 'verification never touches the registry')
check('publish.yml uses concurrency group publish without cancel-in-progress',
  /concurrency:\s*\n\s*group: publish\s*\n\s*cancel-in-progress: false/u.test(publish),
  'two tags must not interleave npm staging; a dispatch must not race a tag run')
check('publish.yml supports workflow_dispatch with a release_tag input',
  /workflow_dispatch:/u.test(publish) && /release_tag:/u.test(publish),
  'an existing tag must be re-stageable without moving it')
check(`publish.yml installs and probes npm ${NPM_VERSION}`,
  publish.includes(`npm install -g npm@${NPM_VERSION}`) && /npm stage --help/u.test(publish),
  `staged publishing needs npm >= 11.15.0; pin ${NPM_VERSION} explicitly and assert "npm stage --help"`)
check('publish.yml stages through "run: node scripts/stage-release.mjs"', /run:\s*node scripts\/stage-release\.mjs/u.test(publish), 'CI must stage via the release script')
check('publish.yml verifies the tag before installing dependencies',
  publish.indexOf('Resolve and verify the release tag') !== -1 &&
  publish.indexOf('Resolve and verify the release tag') < publish.indexOf('Install dependencies'),
  'a bad tag must fail in seconds, before the install/test/build cycle')
check('publish.yml never runs pnpm publish', !/\bpnpm publish\b/u.test(publishExec), 'CI stages and never publishes directly')
check('publish.yml never runs a plain npm publish', !/(?<!stage )\bnpm publish\b/u.test(publishExec), 'CI only runs "npm stage publish" via scripts/stage-release.mjs')
// The summary step PRINTS the exact `gh release create` command for the
// maintainer/agent to run after approval; CI itself must never execute it.
// Every line that mentions `gh release create|edit` must be a printed `echo`
// line (comments are already stripped by `executable`), and `contents: read`
// additionally makes a GitHub Release write impossible from this workflow.
const ghReleaseLines = publishExec.split('\n').filter(line => /gh release (?:create|edit)/u.test(line))
// Printed guidance must be a single plain double-quoted echo: no command
// separators, no backticks, no command substitution inside the string.
const isPrintOnly = line => /^\s*echo\s+"[^"]*"$/u.test(line) && !/[`;]/u.test(line) && !line.includes('$(')
check('publish.yml only prints gh release guidance, never executes it',
  ghReleaseLines.length > 0 && ghReleaseLines.every(isPrintOnly),
  'the GitHub Release is created manually after approval, never by CI')
check('publish.yml never creates or pushes tags', !/\bgit\s+(?:tag|push)\b/u.test(publishExec), 'CI never creates, moves, or deletes tags; push the tag yourself')
check('verify.yml never touches npm staging/publishing/trust', !/\bnpm\s+(?:stage|publish|trust)\b/u.test(verifyExec), 'verification needs no registry credentials')
check('verify.yml never creates the GitHub Release', !/gh release (?:create|edit)/u.test(verifyExec), 'verification is read-only')

const stageScript = existsSync(join(ROOT, 'scripts', 'stage-release.mjs')) ? readFileSync(join(ROOT, 'scripts', 'stage-release.mjs'), 'utf8') : ''
check('stage-release.mjs passes --provenance inside GitHub Actions', /--provenance/u.test(stageScript), 'provenance must be attached when staging in CI')
check('stage-release.mjs defaults prerelease versions to the next dist-tag',
  /options\.distTag = 'next'/u.test(stageScript),
  'prerelease versions (-rc.N etc.) must default to --dist-tag next, never latest')
check('stage-release.mjs rejects an explicit latest dist-tag for prereleases',
  /options\.distTag === 'latest'/u.test(stageScript) && /prerelease/u.test(stageScript),
  'a prerelease staged with latest would make npm install resolve to it on approval; reject it')
// The approval step moved from a local script to the npmjs.com web UI, and the
// GitHub Release is now created manually. Keep those two documentation
// contracts checked: the next-step summary must describe the web approval and
// the `gh release create --verify-tag` command (printed, not executed).
const readme = existsSync(join(ROOT, 'README.md')) ? readFileSync(join(ROOT, 'README.md'), 'utf8') : ''
check('README.md does not reference the removed promote script',
  !/promote-release/u.test(readme),
  'README must describe npmjs.com web approval and the manual "gh release create --verify-tag" step instead')
check('publish.yml summary points at npmjs.com web approval',
  /npmjs\.com/u.test(publishExec),
  'the next-step summary must tell the maintainer to approve the staged version on npmjs.com')
check('publish.yml summary documents the manual GitHub Release with --verify-tag',
  /gh release create/u.test(publishExec) && /--verify-tag/u.test(publishExec),
  'the next-step summary must print "gh release create ... --verify-tag" for the maintainer/agent to run after approval')
check('publish.yml summary prints --notes-file and the stable/prerelease release flags',
  /--notes-file/u.test(publishExec) && /--latest\b/u.test(publishExec) && /--prerelease --latest=false/u.test(publishExec),
  'the printed gh release create command must carry --notes-file plus --latest (stable) or --prerelease --latest=false (prerelease)')
const trustScript = existsSync(join(ROOT, 'scripts', 'trusted-publishers.sh')) ? readFileSync(join(ROOT, 'scripts', 'trusted-publishers.sh'), 'utf8') : ''
check('trusted-publishers.sh configures --allow-stage-publish', /TRUST_ARGS=\([^)]*--allow-stage-publish/u.test(trustScript), 'CI needs stage-only trust')
check('trusted-publishers.sh never grants --allow-publish', !/TRUST_ARGS=\([^)]*--allow-publish\b/u.test(trustScript), 'a publish-only record would let CI publish without human approval')

// ---- report ------------------------------------------------------------------
/** Print the pass/fail list and exit with the aggregate status. */
function report () {
  const failures = checks.filter(entry => !entry.ok)
  for (const entry of checks) {
    if (entry.ok) console.log(`  PASS  ${entry.label}`)
    else console.error(`  FAIL  ${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`)
  }
  for (const note of notes) console.log(`  note: ${note}`)
  console.log('')
  if (failures.length > 0) {
    console.error(`check-packages: ${checks.length - failures.length} passed, ${failures.length} FAILED (of ${checks.length} checks)`)
    process.exit(1)
  }
  console.log(`check-packages: OK (${checks.length} checks, single package ${PACKAGE_NAME})`)
  process.exit(0)
}

report()
