import { AuthProvider, Repo } from "@automerge/automerge-repo"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"
import * as Auth from "@localfirst/auth"
import fs from "fs"
import os from "os"
import path from "path"
import { rimraf } from "rimraf"
import { LocalFirstAuthProvider } from "../../src/index.js"

export const setup = <T extends string>(
  userNames = ["alice", "bob", "charlie"] as T[]
) => {
  // get all possible pairs
  type Pair = [userA: string, userB: string]
  const pairs = userNames.reduce<Pair[]>((result, userA, i) => {
    const newPairs = userNames
      .slice(i + 1)
      .map(userB => [userA, userB]) as Pair[]
    return [...result, ...newPairs]
  }, [])

  // create a channel for each pair & collect all the ports
  const portsByUser = pairs.reduce((result, [userA, userB]) => {
    const channel = new MessageChannel()
    const { port1: a_b, port2: b_a } = channel
    return {
      ...result,
      [userA]: [...(result[userA] ?? []), a_b], // ports for user a
      [userB]: [...(result[userB] ?? []), b_a], // ports for user b
    }
  }, {} as Record<string, MessagePort[]>)

  const ports = Object.values(portsByUser).flat()

  const users = userNames.reduce((result, userName) => {
    const setupRepo = () => {
      portsByUser[userName].forEach(port => {
        port.start()
      })

      const authProvider = new LocalFirstAuthProvider(context)

      const repo = new Repo({
        peerId: user.userId,
        network: portsByUser[userName].map(
          p => new MessageChannelNetworkAdapter(p)
        ),
        storage: new NodeFSStorageAdapter(getStorageDirectory(userName)),
        auth: authProvider,
      })
      return { authProvider, repo }
    }

    const user = Auth.createUser(userName, userName)
    const device = Auth.createDevice(user.userId, `${userName}'s device`)
    const context = { user, device }
    const { authProvider, repo } = setupRepo()

    const restartRepo = () => {
      const { authProvider, repo } = setupRepo()
      return {
        user,
        device,
        context,
        authProvider,
        repo,
        ports,
        restartRepo,
      }
    }

    return {
      ...result,
      [userName]: {
        user,
        device,
        context,
        authProvider,
        repo,
        ports,
        restartRepo,
      },
    }
  }, {} as Record<string, UserStuff>)

  const teardown = () => {
    // close network ports
    ports.forEach(port => port.close())

    // clear storage directories
    userNames.forEach(userName => {
      rimraf.sync(getStorageDirectory(userName))
    })
  }

  return { users, ports, teardown }
}

const getStorageDirectory = (userName: string) => {
  const tempPath = path.join(os.tmpdir(), "automerge-repo-tests", userName)
  if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath)
  return tempPath
}

export interface TestDoc {
  foo: string
}

export type UserStuff = {
  user: Auth.UserWithSecrets
  device: Auth.DeviceWithSecrets
  context: Auth.LocalUserContext
  authProvider: LocalFirstAuthProvider
  repo: Repo
  ports: MessagePort[]
  restartRepo: () => UserStuff
}
