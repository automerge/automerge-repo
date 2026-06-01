#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { intro, outro, text, isCancel, cancel, log } from "@clack/prompts"

const detectPackageManager = (): string => {
  const ua = process.env.npm_config_user_agent ?? ""
  return ua.split(" ")[0]?.split("/")[0] || "npm"
}

const copy = (src: string, dest: string) => {
  if (fs.statSync(src).isDirectory()) {
    copyDir(src, dest)
  } else {
    fs.copyFileSync(src, dest)
  }
}

const copyDir = (srcDir: string, destDir: string) => {
  fs.mkdirSync(destDir, { recursive: true })
  for (const file of fs.readdirSync(srcDir)) {
    copy(path.resolve(srcDir, file), path.resolve(destDir, file))
  }
}

// Written here rather than shipped as a template file: npm strips files named
// .gitignore from published packages, so the template can't carry one directly.
const GITIGNORE = `# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

node_modules
dist
dist-ssr
*.local

# Editor directories and files
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?
`

const main = async () => {
  intro("create-vite-app · Automerge + Vite + React")

  let projectName = process.argv[2]
  if (!projectName) {
    const answer = await text({
      message: "Project name?",
      placeholder: "my-automerge-app",
      validate: value =>
        value && value.trim().length > 0
          ? undefined
          : "Please enter a project name",
    })
    if (isCancel(answer)) {
      cancel("Scaffolding cancelled.")
      process.exit(0)
    }
    projectName = answer.trim()
  }

  const root = path.join(process.cwd(), projectName)
  if (fs.existsSync(root)) {
    cancel(`Directory "${projectName}" already exists.`)
    process.exit(1)
  }

  const templateDir = path.resolve(
    fileURLToPath(import.meta.url),
    "../../template"
  )

  fs.mkdirSync(root, { recursive: true })
  for (const file of fs.readdirSync(templateDir)) {
    if (file === "package.json") continue
    copy(path.join(templateDir, file), path.join(root, file))
  }

  // Copy package.json with the chosen project name.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(templateDir, "package.json"), "utf-8")
  )
  pkg.name = projectName
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n"
  )

  fs.writeFileSync(path.join(root, ".gitignore"), GITIGNORE)

  log.success(`Created ${projectName}`)

  const pm = detectPackageManager()
  const run = pm === "npm" ? "npm run" : pm
  outro(
    [
      "Next steps:",
      `  cd ${projectName}`,
      `  ${pm} install`,
      `  ${run} dev`,
    ].join("\n")
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
