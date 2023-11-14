import { PeerId, Repo } from "@automerge/automerge-repo"
import { LocalFirstAuthProvider } from "@automerge/automerge-repo-auth-localfirst"
import { eventPromise } from "@automerge/automerge-repo-auth-localfirst/test/helpers/eventPromise"
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { Team, createDevice, createKeyset, createUser } from "@localfirst/auth"
import fs from "fs"
import os from "os"
import path from "path"
import { getPortPromise as getAvailablePort } from "portfinder"
import { describe, expect, it } from "vitest"
import { LocalFirstAuthSyncServer } from "../src/index.js"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"

const storageDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "automerge-repo-tests")
)
const host = "localhost"

describe("LocalFirstAuthSyncServer", () => {
  let url: string
  let server: LocalFirstAuthSyncServer

  const setup = async () => {
    const port = await getAvailablePort({ port: 3100 })
    url = `localhost:${port}`
    server = new LocalFirstAuthSyncServer(host)
    await server.listen({ port, silent: true, storageDir })
    return { url, server }
  }

  it("should start a server", async () => {
    const { url } = await setup()
    const response = await fetch(`http://${url}`)
    const text = await response.text()

    // the server responds with a string like "Sync server is running"
    expect(text).toContain("running")
  })

  it("should return the server's public keys", async () => {
    const { url, server } = await setup()
    const response = await fetch(`http://${url}/keys`)
    const keys = await response.json()

    // the keys look like keys
    expect(lookLikeServerKeys(keys)).toBe(true)

    // they match the server's public keys
    expect(server.publicKeys).toEqual(keys)
  })

  it("should add a team", async () => {
    const { url, server } = await setup()

    const user = createUser("alice", "alice")
    const device = createDevice(user.userId, "laptop")

    // create a team
    const teamKeys = createKeyset({ type: "TEAM", name: "TEAM" })
    const team = new Team({
      teamName: "team A",
      context: { user, device },
      teamKeys,
    })

    // add the team to a new auth provider

    const storage = new NodeFSStorageAdapter(storageDir)
    const auth = new LocalFirstAuthProvider({ user, device, storage })
    auth.addTeam(team)

    const socketAdapter = auth.wrap(
      new BrowserWebSocketClientAdapter(`ws://${url}`)
    )

    // set up our repo
    const repo = new Repo({
      peerId: user.userId as PeerId,
      network: [socketAdapter],
      storage,
    })

    // get the server's public keys
    const response = await fetch(`http://${url}/keys`)
    const keys = await response.json()

    // add the server's public keys to the team
    team.addServer({ host, keys })

    // register the team with the server
    // (we don't await this because otherwise peer will fire before we're listening)
    void fetch(`http://${url}/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serializedGraph: team.save(),
        teamKeyring: team.teamKeyring(),
      }),
    })

    // when we're authenticated, we get a peer event
    const { peerId } = await eventPromise(repo.networkSubsystem, "peer")
    expect(peerId).toEqual(host)
  })
})

const lookLikeServerKeys = (maybeKeyset: any) =>
  maybeKeyset.type === "SERVER" &&
  maybeKeyset.name === host &&
  maybeKeyset.generation === 0 &&
  typeof maybeKeyset.encryption === "string" &&
  typeof maybeKeyset.signature === "string"
