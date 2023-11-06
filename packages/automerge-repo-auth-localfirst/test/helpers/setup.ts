import { Repo } from "@automerge/automerge-repo"
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

  const allPorts = Object.values(portsByUser).flat()

  const users = userNames.reduce((result, userName) => {
    const storageDir = getStorageDirectory()
    const setupRepo = (ports: MessagePort[]) => {
      const authProvider = new LocalFirstAuthProvider(context)

      const repo = new Repo({
        peerId: user.userId,
        network: ports.map(port => new MessageChannelNetworkAdapter(port)),
        storage: new NodeFSStorageAdapter(storageDir),
        auth: authProvider,
      })
      return { authProvider, repo }
    }

    const user = Auth.createUser(userName, userName)
    const device = Auth.createDevice(user.userId, `${userName}'s device`)
    const context = { user, device }
    const { authProvider, repo } = setupRepo(portsByUser[userName])

    const restartRepo = (ports: MessagePort[]) => {
      const { authProvider, repo } = setupRepo(ports)
      return {
        user,
        device,
        context,
        authProvider,
        repo,
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
        restartRepo,
      },
    }
  }, {} as Record<string, UserStuff>)

  const teardown = () => {
    // close network ports
    allPorts.forEach(port => port.close())

    // clear storage directories
    userNames.forEach(userName => {
      rimraf.sync(getStorageDirectory())
    })
  }

  return { users, teardown }
}

const getStorageDirectory = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "automerge-repo-tests"))

export interface TestDoc {
  foo: string
}

export type UserStuff = {
  user: Auth.UserWithSecrets
  device: Auth.DeviceWithSecrets
  context: Auth.LocalUserContext
  authProvider: LocalFirstAuthProvider
  repo: Repo
  restartRepo: (ports: MessagePort[]) => UserStuff
}
