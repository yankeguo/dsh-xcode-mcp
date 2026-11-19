#!/usr/bin/env bash
# Configure npm trusted publishing (keyless OIDC) for the one publishable
# package of this repository (@yankeguo/dsh-xcode-mcp, the root package.json),
# scoped to STAGED publishing only (--allow-stage-publish).
#
# Run this once after the package's FIRST publish (npm requires the package to
# exist before a trusted publisher can be attached; this package is already
# public — `0.0.0-stage` and `0.1.0-rc.1` — see docs/PUBLISHING.md "新包首次发布").
# Afterward .github/workflows/publish.yml stages new versions with a short-lived
# OIDC token and no NPM_TOKEN secret at all; a human then approves the staged
# version locally with scripts/promote-release.mjs.
#
# The CI workflow never publishes directly. A trusted-publisher record created
# with --allow-publish does NOT authorize `npm stage publish`; such old records
# must be revoked and recreated by this script (see the migration hint printed
# on failure, and docs/PUBLISHING.md).
#
# Prerequisites:
#   - npm >= 11.15.0 (staged publishing: `npm stage publish/list/approve/...` and
#     `npm trust --allow-stage-publish`); this repository pins 11.20.0, so
#     upgrade with `npm install -g npm@11.20.0`
#   - 2FA enabled on the npm account
#   - npm login as an account with write access to the @yankeguo packages
#     (npm trust does not accept bypass-2FA granular tokens)
#   - the package already exists on the registry (first publish is manual)
#
# Usage:
#   scripts/trusted-publishers.sh                     # configure the package
#   scripts/trusted-publishers.sh --dry-run           # show what it would do
#   scripts/trusted-publishers.sh --list              # list current config
#   scripts/trusted-publishers.sh --env npm-publish   # bind a GitHub environment
#   scripts/trusted-publishers.sh --repo owner/repo --file publish.yml
#
# The workflow filename must match .github/workflows/<file> exactly; the
# optional GitHub environment must also be set on the workflow job for the
# claims to match.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="yankeguo/dsh-xcode-mcp"
WORKFLOW_FILE="publish.yml"
ENVIRONMENT=""
MODE="configure"

# Print this script's header comment block as --help output.
usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE="dry-run"; shift ;;
    --list) MODE="list"; shift ;;
    --repo) REPO="${2:?--repo needs owner/repo}"; shift 2 ;;
    --file) WORKFLOW_FILE="${2:?--file needs a filename}"; shift 2 ;;
    --env|--environment) ENVIRONMENT="${2:?--env needs a name}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Reject values the registry would only reject after a round trip. npm requires
# the bare workflow filename (no directory) and an owner/repository pair.
if [[ ! "${WORKFLOW_FILE}" =~ ^[A-Za-z0-9._-]+\.ya?ml$ ]]; then
  echo "--file must be a bare workflow filename ending in .yml/.yaml (got ${WORKFLOW_FILE})" >&2
  exit 2
fi
if [[ ! "${REPO}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "--repo must be owner/repository (got ${REPO})" >&2
  exit 2
fi

# ---- prerequisites ---------------------------------------------------------
command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 2; }

npm_version="$(npm --version)"
node_version="$(node --version)"
echo "npm ${npm_version} / node ${node_version}"
# Capability checks instead of version parsing: these are the features we
# actually need, and old npm versions print an unknown-command error.
if ! npm trust --help >/dev/null 2>&1; then
  echo "npm >= 11.15.0 is required for 'npm trust --allow-stage-publish' (found ${npm_version}); run: npm install -g npm@11.20.0" >&2
  exit 2
fi
if ! npm stage --help >/dev/null 2>&1; then
  echo "npm >= 11.15.0 is required for staged publishing ('npm stage', found ${npm_version}); this repo pins 11.20.0, run: npm install -g npm@11.20.0" >&2
  exit 2
fi

# Read the one publishable package name from the root manifest (single package:
# the root package.json IS the package; there is no packages/ workspace).
PACKAGE_NAME="$(node - "${REPO_ROOT}/package.json" <<'NODE'
const fs = require('node:fs')
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (manifest.private === true) {
  console.error('package.json is "private": true; remove it (publish form) before configuring trust — see docs/PUBLISHING.md')
  process.exit(1)
}
if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@')) {
  console.error('package.json must declare a scoped package name')
  process.exit(1)
}
process.stdout.write(manifest.name)
NODE
)"

echo "repository: ${REPO}"
echo "workflow:   ${WORKFLOW_FILE}"
echo "capability: stage-publish (npm stage publish)"
[[ -n "${ENVIRONMENT}" ]] && echo "environment: ${ENVIRONMENT}"
echo "package:    ${PACKAGE_NAME}"

# npm trust only needs the registry and the per-user config; running it from a
# neutral directory keeps the repository's pnpm-only .npmrc out of npm's config
# warnings.
npm_trust() {
  ( cd / && npm trust "$@" )
}

# ---- list mode -------------------------------------------------------------
if [[ "${MODE}" == "list" ]]; then
  echo ""
  echo "== ${PACKAGE_NAME} =="
  if ! npm_trust list "${PACKAGE_NAME}"; then
    echo "   FAILED to list ${PACKAGE_NAME} (not logged in?)" >&2
    exit 1
  fi
  exit 0
fi

# ---- configure -------------------------------------------------------------
# --allow-stage-publish is the capability the CI workflow needs: it may upload
# a staged version, but it may not publish directly. Never use --allow-publish
# here: a publish-only record would reject `npm stage publish` from CI.
TRUST_ARGS=(--file "${WORKFLOW_FILE}" --repo "${REPO}" --allow-stage-publish --yes)
[[ -n "${ENVIRONMENT}" ]] && TRUST_ARGS+=(--env "${ENVIRONMENT}")
[[ "${MODE}" == "dry-run" ]] && TRUST_ARGS+=(--dry-run)

echo ""
echo "trust configuration: github ${REPO} // ${WORKFLOW_FILE} (--allow-stage-publish)"
echo ""
echo "== configuring ${PACKAGE_NAME} =="
if npm_trust github "${PACKAGE_NAME}" "${TRUST_ARGS[@]}"; then
  echo "   OK ${PACKAGE_NAME}"
else
  echo "   FAILED ${PACKAGE_NAME}" >&2
  echo "" >&2
  echo "If the package reports an existing or conflicting configuration (including" >&2
  echo "records created earlier with --allow-publish, which do NOT allow staged" >&2
  echo "publishing), migrate it explicitly:" >&2
  echo "  npm trust list ${PACKAGE_NAME}                 # note the id of the GitHub Actions record" >&2
  echo "  npm trust revoke ${PACKAGE_NAME} --id=<id>     # revoke the stale/publish-only record" >&2
  echo "  scripts/trusted-publishers.sh                  # recreate it with --allow-stage-publish" >&2
  echo "" >&2
  echo "If the package does not exist on the registry yet, publish it once manually" >&2
  echo "first (docs/PUBLISHING.md \"新包首次发布\"), then re-run this script." >&2
  echo "" >&2
  echo "There may be at most 10 trusted publishers per package; revoke records that" >&2
  echo "point at renamed workflows or repositories." >&2
  exit 1
fi

echo ""
echo "${PACKAGE_NAME} allows staged publishing from ${REPO} // ${WORKFLOW_FILE}."
echo "Next steps:"
echo "  1. push a v* tag (or run workflow_dispatch with an existing release_tag)"
echo "     -> .github/workflows/${WORKFLOW_FILE} stages the package, publishes nothing"
echo "  2. a maintainer runs scripts/promote-release.mjs locally (npm login + 2FA)"
echo "     to approve the staged version and create the GitHub Release"
