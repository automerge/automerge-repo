#!/usr/bin/env node
// This is needed to tell your system that this file is a Node script.

import fs from 'fs'
import path from 'path'
import child_process from 'child_process'

const execSync = child_process.execSync

function createPackageJson(projectName: string) {
  const packageJson = {
    name: projectName,
    version: '1.0.0',
    description: '',
    main: 'index.js',
    type: 'module',
    scripts: {
      start: 'node index.js',
    },
    dependencies: {
      '@automerge/automerge-repo': '^0.1',
      '@automerge/automerge-repo-network-websocket': '^0.1',
      '@automerge/automerge-repo-storage-nodefs': '^0.1',
    },
  }
  fs.writeFileSync(
    path.join(projectName, 'package.json'),
    JSON.stringify(packageJson, null, 2) + '\n'
  )
}

function createIndexJs(projectName: string) {
  const indexJsContent = `import { Repo } from "@automerge/automerge-repo"
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"
import { next as Automerge } from "@automerge/automerge"

const repo = new Repo({
  storage: [new NodeFSStorageAdapter("./db")],
  network: [new BrowserWebSocketClientAdapter("wss://sync.automerge.org")]
})
`
  fs.writeFileSync(path.join(projectName, 'index.js'), indexJsContent)
}

function main() {
  const projectName = process.argv[2]
  if (!projectName) {
    console.error('Please provide a project name')
    process.exit(1)
  }

  fs.mkdirSync(projectName)
  createPackageJson(projectName)
  createIndexJs(projectName)
  execSync(`cd ${projectName} && npm install`, { stdio: 'inherit' })
}

main()

