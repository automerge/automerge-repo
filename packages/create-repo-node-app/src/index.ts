#!/usr/bin/env node

import fs from "fs"
import path from "path"
import child_process from "child_process"

const execSync = child_process.execSync

function createPackageJson(projectName: string) {
  const packageJson = {
    name: projectName,
    version: "1.0.0",
    description: "",
    main: "index.js",
    type: "module",
    scripts: {
      start: "node index.js",
    },
    dependencies: {
      "@automerge/automerge-repo": "^1.0",
      "@automerge/automerge-repo-network-websocket": "^1.0",
      "@automerge/automerge-repo-storage-nodefs": "^1.0",
    },
  }
  fs.writeFileSync(
    path.join(projectName, "package.json"),
    JSON.stringify(packageJson, null, 2) + "\n"
  )
}

function createIndexJs(projectName: string) {
  const indexJsContent = `import { Repo } from "@automerge/automerge-repo"
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"

const repo = new Repo({
  storage: new NodeFSStorageAdapter("./db"),
  network: [new WebSocketClientAdapter("wss://sync.automerge.org")]
})
`
  fs.writeFileSync(path.join(projectName, "index.js"), indexJsContent)
}

function main() {
  const projectName = process.argv[2]
  if (!projectName) {
    console.error("Please provide a project name")
    process.exit(1)
  }

  fs.mkdirSync(projectName)
  createPackageJson(projectName)
  createIndexJs(projectName)
  execSync(`cd ${projectName} && npm install`, { stdio: "inherit" })
}

main()
