import { PeerId, Repo } from "@automerge/automerge-repo"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"
import * as Auth from "@localfirst/auth"
import fs from "fs"
import os from "os"
import path from "path"
import { rimraf } from "rimraf"
import { LocalFirstAuthProvider } from "@automerge/automerge-repo-auth-localfirst"
import { getPortPromise as getAvailablePort } from "portfinder"
import { LocalFirstAuthSyncServer } from "../../src/index.js"
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"

export const host = "localhost"

export const setup = async <T extends string>(userNames = [] as T[]) => {
  const port = await getAvailablePort({ port: 3100 })
  const url = `localhost:${port}`
  const server = new LocalFirstAuthSyncServer(host)
  await server.listen({
    port,
    silent: true,
    storageDir: getStorageDirectory("server"),
  })

  const users = userNames.reduce((result, userName) => {
    const storageDir = getStorageDirectory(userName)
    const user = Auth.createUser(userName)
    const device = Auth.createDevice(user.userId, `${userName}'s device`)
    const context = { user, device }
    const storage = new NodeFSStorageAdapter(storageDir)
    const authProvider = new LocalFirstAuthProvider({ user, device, storage })
    const socketAdapter = authProvider.wrap(
      new BrowserWebSocketClientAdapter(`ws://${url}`)
    )
    const repo = new Repo({
      peerId: device.deviceId as PeerId,
      network: [socketAdapter],
      storage,
    })

    return {
      ...result,
      [userName]: { user, device, context, authProvider, repo },
    }
  }, {} as Record<string, UserStuff>)

  const teardown = () => {
    // close the server connections and disconnect all clients
    server.close()
    rimraf.sync(getStorageDirectory("server"))
    // clear storage directories
    userNames.forEach(userName => {
      rimraf.sync(getStorageDirectory(userName))
    })
  }

  return { users, teardown, url, server }
}

export const getStorageDirectory = (userName: string) =>
  fs.mkdtempSync(path.join(os.tmpdir(), `automerge-repo-tests-${userName}-`))

export type UserStuff = {
  user: Auth.UserWithSecrets
  device: Auth.DeviceWithSecrets
  context: Auth.LocalUserContext
  authProvider: LocalFirstAuthProvider
  repo: Repo
}
