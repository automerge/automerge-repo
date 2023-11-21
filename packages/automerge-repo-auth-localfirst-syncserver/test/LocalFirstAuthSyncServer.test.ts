import { eventPromise } from "@automerge/automerge-repo-auth-localfirst/test/helpers/eventPromise"
import { Team, createTeam, loadTeam, device } from "@localfirst/auth"

import { describe, expect, it } from "vitest"
import { LocalFirstAuthSyncServer } from "../src/index.js"
import { host, setup } from "./helpers/setup.js"

describe("LocalFirstAuthSyncServer", () => {
  let url: string
  let server: LocalFirstAuthSyncServer

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

  it("Alice can create a team", async () => {
    const { users, url, server } = await setup(["alice"])
    const { alice } = users

    // create a team
    const teamContext = { user: alice.user, device: alice.device }

    const team = createTeam("team A", teamContext)
    alice.authProvider.addTeam(team)

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
    const { peerId } = await eventPromise(alice.repo.networkSubsystem, "peer")
    expect(peerId).toEqual(host)
  })
})

const lookLikeServerKeys = (maybeKeyset: any) =>
  maybeKeyset.type === "SERVER" &&
  maybeKeyset.name === host &&
  maybeKeyset.generation === 0 &&
  typeof maybeKeyset.encryption === "string" &&
  typeof maybeKeyset.signature === "string"
