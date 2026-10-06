import { spawn } from "node:child_process"
import { readIndex, prepare, directory, command } from "./prepare.mjs"

const name =
  process.argv.find(arg => arg.startsWith("--target="))?.slice(9) ?? "poc"
const defaults = {
  main: ["base/main", "legacy"],
  subductionjs: ["base/subductionjs", "subductionjs"],
}
const index = await readIndex()
const info =
  name === "poc"
    ? null
    : (index[name] ??
      (defaults[name] && (await prepare(name, ...defaults[name]))))
if (name !== "poc" && !info)
  throw new Error(
    `Unknown target ${name}; run pnpm bench:prepare name=ref:adapter`
  )
const child = spawn("pnpm", ["exec", "vite", "--open"], {
  cwd: directory,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_BENCH_NAME: name,
    VITE_BENCH_COMMIT: info?.sha ?? command("git", ["rev-parse", "HEAD"]),
    BENCH_ADAPTER: info?.adapter ?? "poc",
    BENCH_TARGET_DIR: info?.path ?? "",
  },
})
process.on("SIGINT", () => child.kill("SIGINT"))
process.on("SIGTERM", () => child.kill("SIGTERM"))
process.exitCode = await new Promise(resolve =>
  child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)))
)
