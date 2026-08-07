import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import path, { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOT_PACKAGE_PATH = path.join(REPO_ROOT, "package.json")
const usage = `Usage:
  version.mjs bump
  version.mjs check [--tag <tag>]
  version.mjs has-changed [<before commitish>] [<after commitish>]
  version.mjs tag [<commitish>]
  version.mjs help

Manage the version shared by the packages in this repository. The version in
the root package.json is the source of truth; package.json files for packages
listed by pnpm are kept in sync with it.

Commands:
  bump
    Update each package version to match the root package.json. Files that
    already have the correct version are left unchanged.

  check [--tag <tag>]
    Check without modifying files that every package version matches the root
    package.json. With --tag, also require the tag to equal "v<version>".

  has-changed [<before commitish>] [<after commitish>]
    Compare the root package version stored in two Git commits. Print the new
    version when it changed, or print nothing when it did not. The commitishes
    default to HEAD~1 and HEAD.

  tag [<commitish>]
    Create the annotated local tag "v<version>" for a commit, defaulting to
    HEAD, and print its name. Succeed if that tag already targets the commit;
    fail rather than move it if it targets another commit. This does not push
    the tag to a remote.

  help, --help, -h
    Show this help text.`

function main([command, ...args]) {
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      if (args.length !== 0) throw new Error(usage)
      console.log(usage)
      return
    case "bump":
      return bumpVersions(args)
    case "check":
      return checkVersions(args)
    case "has-changed":
      return hasVersionChanged(args)
    case "tag":
      return createTag(args)
    default:
      throw new Error(usage)
  }
}

function bumpVersions(args) {
  if (args.length !== 0) throw new Error(usage)

  const version = readRootVersion()
  let updated = 0

  for (const packageJsonPath of packageJsonPaths()) {
    const pkg = readPackage(packageJsonPath)
    if (pkg.version === version) continue

    pkg.version = version
    writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
    console.log(
      `updated ${path.relative(REPO_ROOT, packageJsonPath)} -> ${version}`
    )
    updated += 1
  }

  if (updated === 0)
    console.log(`all package versions already match ${version}`)
}

function checkVersions(args) {
  let expectedTag

  if (args.length === 2 && args[0] === "--tag") {
    expectedTag = args[1]
  } else if (args.length !== 0) {
    throw new Error(usage)
  }

  const version = readRootVersion()
  const mismatches = []

  for (const packageJsonPath of packageJsonPaths()) {
    const pkg = readPackage(packageJsonPath)
    const relativePath = path.relative(REPO_ROOT, packageJsonPath)

    if (pkg.version !== version) {
      mismatches.push(`${relativePath}: ${pkg.version ?? "<missing>"}`)
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Package versions do not match ${version}:\n${mismatches
        .map(mismatch => `  ${mismatch}`)
        .join("\n")}`
    )
  }

  if (expectedTag !== undefined && expectedTag !== `v${version}`) {
    throw new Error(
      `Tag ${expectedTag} does not match package.json version ${version}`
    )
  }

  console.log(`all package versions match ${version}`)
}

function hasVersionChanged(args) {
  if (args.length > 2) throw new Error(usage)

  const before = args[0] ?? "HEAD~1"
  const after = args[1] ?? "HEAD"
  const beforeVersion = readVersionAt(before)
  const afterVersion = readVersionAt(after)

  if (beforeVersion !== afterVersion) process.stdout.write(`${afterVersion}\n`)
}

function createTag(args) {
  if (args.length > 1) throw new Error(usage)

  const commitish = args[0] ?? "HEAD"
  const commit = resolveCommitish(commitish)
  const tag = `v${readVersionAt(commit)}`
  const existing = git(
    ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`],
    { allowFailure: true }
  )

  if (existing.status === 0) {
    const existingCommit = existing.stdout.trim()
    if (existingCommit !== commit) {
      throw new Error(
        `Tag ${tag} already points to ${existingCommit}, not ${commit}`
      )
    }
  } else {
    git(["tag", "--annotate", tag, "--message", `Release ${tag}`, commit])
  }

  process.stdout.write(`${tag}\n`)
}

function readRootVersion() {
  return readVersion(readPackage(ROOT_PACKAGE_PATH), ROOT_PACKAGE_PATH)
}

function packageJsonPaths() {
  const result = pnpm(["list", "--recursive", "--depth", "-1", "--json"])
  const packages = readJson(result.stdout, "pnpm package list")

  if (!Array.isArray(packages)) {
    throw new Error("Expected pnpm package list to be an array")
  }

  return packages
    .map(pkg => {
      if (typeof pkg.path !== "string" || pkg.path.length === 0) {
        throw new Error("Missing package path in pnpm package list")
      }
      return path.join(pkg.path, "package.json")
    })
    .filter(packageJsonPath => packageJsonPath !== ROOT_PACKAGE_PATH)
    .sort((a, b) => a.localeCompare(b))
}

function readVersionAt(commitish) {
  const commit = resolveCommitish(commitish)
  const result = git(["show", `${commit}:package.json`])
  const source = `package.json at ${commitish}`
  return readVersion(readJson(result.stdout, source), source)
}

function resolveCommitish(commitish) {
  const result = git(
    ["rev-parse", "--verify", "--end-of-options", `${commitish}^{commit}`],
    { allowFailure: true }
  )

  if (result.status !== 0) {
    throw new Error(`Invalid commitish: ${commitish}`)
  }

  return result.stdout.trim()
}

function readPackage(packagePath) {
  return readJson(readFileSync(packagePath, "utf8"), packagePath)
}

function readVersion(pkg, source) {
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(`Missing version in ${source}`)
  }

  return pkg.version
}

function readJson(contents, source) {
  try {
    return JSON.parse(contents)
  } catch (error) {
    throw new Error(`Could not parse ${source}: ${error.message}`)
  }
}

function git(args, { allowFailure = false } = {}) {
  return run("git", args, { allowFailure })
}

function pnpm(args) {
  return run("pnpm", args)
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })

  if (result.status === null && result.error) {
    throw new Error(`Could not run ${command}: ${result.error.message}`)
  }

  if (result.status !== 0 && !allowFailure) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(detail || `${command} ${args.join(" ")} failed`)
  }

  return result
}

try {
  main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
