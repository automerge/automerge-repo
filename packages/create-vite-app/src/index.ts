#!/usr/bin/env node

import fs from "fs"
import path from "path"
import child_process from "child_process"
import { fileURLToPath } from "node:url"

const execSync = child_process.execSync

function main() {
  const projectName = process.argv[2]
  if (!projectName) {
    console.error("Please provide a project name")
    process.exit(1)
  }

  const templateDir = path.resolve(
    fileURLToPath(import.meta.url),
    "../../template"
  )

  const root = path.join(process.cwd(), projectName)
  const write = (file: string, content?: string) => {
    const targetPath = path.join(root, file)
    if (content) {
      fs.writeFileSync(targetPath, content)
    } else {
      copy(path.join(templateDir, file), targetPath)
    }
  }

  fs.mkdirSync(projectName)
  const files = fs.readdirSync(templateDir)
  for (const file of files.filter(f => f !== "package.json")) {
    write(file)
  }

  const pkg = JSON.parse(
    fs.readFileSync(path.join(templateDir, `package.json`), "utf-8")
  )
  pkg.name = projectName
  write("package.json", JSON.stringify(pkg, null, 2))

  execSync(`cd ${projectName} && npm install`, { stdio: "inherit" })
}

main()

function copy(src: string, dest: string) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    copyDir(src, dest)
  } else {
    fs.copyFileSync(src, dest)
  }
}

function copyDir(srcDir: string, destDir: string) {
  fs.mkdirSync(destDir, { recursive: true })
  for (const file of fs.readdirSync(srcDir)) {
    const srcFile = path.resolve(srcDir, file)
    const destFile = path.resolve(destDir, file)
    copy(srcFile, destFile)
  }
}
