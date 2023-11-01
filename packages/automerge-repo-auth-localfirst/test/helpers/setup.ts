import { Repo } from "@automerge/automerge-repo"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import * as Auth from "@localfirst/auth"
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
  const ports = pairs.reduce((result, [userA, userB]) => {
    const channel = new MessageChannel()
    const { port1: a_b, port2: b_a } = channel
    return {
      ...result,
      [userA]: [...(result[userA] ?? []), a_b], // ports for user a
      [userB]: [...(result[userB] ?? []), b_a], // ports for user b
    }
  }, {} as Record<string, MessagePort[]>)

  const allPorts = Object.values(ports).flat()

  const users = userNames.reduce((result, userName) => {
    const user = Auth.createUser(userName, userName)
    const device = Auth.createDevice(user.userId, `${userName}'s device`)
    const context = { user, device }
    const authProvider = new LocalFirstAuthProvider(context)
    const repo = new Repo({
      peerId: user.userId,
      network: ports[userName].map(p => new MessageChannelNetworkAdapter(p)),
      authProvider,
    })
    return {
      ...result,
      [userName]: { user, device, context, authProvider, repo },
    }
  }, {} as Record<string, UserStuff>)

  return {
    users,
    ports,
    teardown: () => {
      allPorts.forEach(port => port.close())
    },
  }
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
}
