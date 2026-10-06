import { chromium } from "playwright"
import { spawn, execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const directory = fileURLToPath(new URL(".", import.meta.url))
const root = fileURLToPath(new URL("../../", import.meta.url))
const smoke = process.argv.includes("--smoke")
const reseed = process.argv.includes("--reseed")
const edits = process.argv.find(arg => arg.startsWith("--edits="))?.slice(8)
const targetName = process.env.BENCH_NAME ?? "poc"
const runs = Number(
  process.argv.find(arg => arg.startsWith("--runs="))?.slice(7) ?? 1
)
if (!Number.isSafeInteger(runs) || runs < 1)
  throw new Error("--runs must be a positive integer")

const server = spawn(
  "pnpm",
  [
    "exec",
    "vite",
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    "4173",
    "--strictPort",
  ],
  {
    cwd: directory,
    stdio: "inherit",
  }
)
let browser
try {
  const params = new URLSearchParams()
  if (smoke) params.set("smoke", "")
  if (reseed) params.set("reseed", "")
  if (edits) params.set("edits", edits)
  const url = `http://127.0.0.1:4173/${params.size ? `?${params}` : ""}`
  let ready = false
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error("Preview server stopped")
    try {
      const response = await fetch(url)
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      /* Preview not ready yet. */
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error("Preview server did not start")
  await mkdir(join(directory, "results"), { recursive: true })
  await mkdir(join(directory, "results", "profiles"), { recursive: true })
  browser = await chromium.launchPersistentContext(
    join(directory, "results", "profiles", targetName)
  )
  const revision =
    process.env.VITE_BENCH_COMMIT ??
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim()
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: process.env.BENCH_TARGET_DIR || root,
      encoding: "utf8",
    }).trim() !== ""
  for (let i = 0; i < runs; i++) {
    const page = await browser.newPage()
    let completed
    try {
      page.on("console", message => {
        if (message.type() === "error") console.error(message.text())
      })
      page.on("pageerror", error => console.error(error))
      await page.goto(url)
      await page.waitForFunction(() => !!window.benchmark, null, {
        timeout: 60000,
      })
      console.log(`Run ${i + 1}/${runs}: ${url}`)
      const progress = setInterval(() => {
        void page
          .locator("#status")
          .textContent()
          .then(text => console.log(text))
          .catch(() => {})
      }, 10000)
      let result
      try {
        await page.evaluate(() => window.benchmark.prepare())
        await page.evaluate(() => {
          const next = new URL(location.href)
          next.searchParams.delete("reseed")
          history.replaceState(null, "", next)
        })
        await page.reload()
        await page.waitForFunction(() => !!window.benchmark, null, {
          timeout: 60000,
        })
        result = await page.evaluate(() => window.benchmark.run())
      } catch (error) {
        console.error(
          "Browser status:",
          await page.locator("#status").textContent()
        )
        throw error
      } finally {
        clearInterval(progress)
      }
      const output = {
        ...result,
        revision,
        dirty,
        browser: browser.browser()?.version(),
      }
      completed = output
      const name = `browser-${targetName}-${smoke ? "smoke-" : ""}${new Date().toISOString().replaceAll(":", "-")}-${i + 1}.json`
      await writeFile(
        join(directory, "results", name),
        JSON.stringify(output, null, 2) + "\n"
      )
      console.log(`Saved results/${name}`)
      if (process.env.BENCH_RESULT_FILE)
        await writeFile(
          process.env.BENCH_RESULT_FILE,
          JSON.stringify(output, null, 2) + "\n"
        )
    } finally {
      await page.close()
    }
    if (completed?.edits?.verified && completed.editDatabase) {
      const cleanup = await browser.newPage()
      try {
        await cleanup.goto(
          new URL("/fixtures/v1/manifest.json", url).toString(),
          { waitUntil: "domcontentloaded", timeout: 10000 }
        )
        await cleanup.evaluate(
          name =>
            new Promise((resolve, reject) => {
              const request = indexedDB.deleteDatabase(name)
              request.onsuccess = resolve
              request.onerror = () => reject(request.error)
              request.onblocked = () =>
                reject(new Error("Edit database deletion blocked"))
            }),
          completed.editDatabase
        )
      } catch (error) {
        console.warn(`Deferred cleanup for ${completed.editDatabase}: ${error}`)
      } finally {
        await cleanup.close()
      }
    }
  }
} finally {
  await browser?.close()
  server.kill()
}
