import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

export const root = fileURLToPath(new URL("../../", import.meta.url))
export const directory = fileURLToPath(new URL(".", import.meta.url))
const defaultCache =
  platform() === "darwin"
    ? join(homedir(), "Library", "Caches")
    : (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"))
export const cache =
  process.env.BENCH_CACHE_DIR ??
  join(
    defaultCache,
    "automerge-repo-bench",
    createHash("sha256").update(root).digest("hex").slice(0, 12)
  )

export function command(program, args, cwd = root, env = process.env) {
  if (program === "pnpm") {
    execFileSync(program, args, { cwd, env, stdio: "inherit" })
    return ""
  }
  const output = execFileSync(program, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
    maxBuffer: 10 * 1024 * 1024,
  }).trim()
  return output
}

export async function readIndex() {
  try {
    return JSON.parse(await readFile(join(cache, "index.json"), "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return {}
    throw error
  }
}

export async function prepare(name, ref, adapter) {
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new Error(`Invalid target name: ${name}`)
  if (!["legacy", "subductionjs"].includes(adapter))
    throw new Error(`Unsupported adapter: ${adapter}`)
  const sha = command("git", ["rev-parse", `${ref}^{commit}`])
  const path = join(cache, "targets", sha)
  await mkdir(join(cache, "targets"), { recursive: true })
  if (!existsSync(path)) {
    console.log(`Creating worktree ${path} from ${ref} (${sha})`)
    command("git", ["worktree", "add", "--detach", path, sha])
  }
  if (
    command("git", ["rev-parse", "HEAD"], path) !== sha ||
    command("git", ["status", "--porcelain"], path)
  )
    throw new Error(`Target worktree not clean at ${sha}: ${path}`)
  const built = join(
    path,
    "packages",
    "automerge-repo-storage-indexeddb",
    "dist",
    "index.js"
  )
  if (!existsSync(built)) {
    console.log(`Installing and building ${name} at ${path}`)
    command("corepack", ["pnpm", "install", "--frozen-lockfile"], path)
    command(
      "corepack",
      [
        "pnpm",
        "--filter",
        "@automerge/automerge-repo-storage-indexeddb...",
        "build",
      ],
      path
    )
  }
  const index = await readIndex()
  index[name] = { name, ref, sha, adapter, path }
  await writeFile(
    join(cache, "index.json"),
    JSON.stringify(index, null, 2) + "\n"
  )
  console.log(`Prepared ${name}: ${sha} (${adapter}) at ${path}`)
  return index[name]
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const match = /^([a-z][a-z0-9-]*)=([^:]+):(legacy|subductionjs)$/.exec(
    process.argv[2] ?? ""
  )
  if (!match)
    throw new Error("Usage: pnpm bench:prepare name=ref:legacy|subductionjs")
  await prepare(match[1], match[2], match[3])
}
