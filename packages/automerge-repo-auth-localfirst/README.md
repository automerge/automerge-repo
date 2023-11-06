<img src="https://raw.githubusercontent.com/local-first-web/branding/main/svg/auth-h.svg"
width="300" alt="@localfirst/auth logo" />

# Local-first auth provider for Automerge Repo

This is an `AuthProvider` that uses the [localfirst/auth](https://github.com/local-first-web/auth)
library to provide Automerge Repo with authentication and end-to-end encryption, without the need
for a central server.

## Making an authenticated connection

A `LocalFirstAuthProvider` is configured with information about the local user and device.

```ts
import { createUser, createDevice } from "@localfirst/auth"
import { LocalFirstAuthProvider } from "@automerge/automerge-repo-auth-localfirst"

// Create the user & device, or retrieve them from storage.
// These objects include secret keys, so need to be stored securely.
const alice = createUser("alice")
const aliceLaptop = createDevice(alice.userId, "ALICE-MACBOOK-2023")
const aliceContext = { user: alice, device: aliceLaptop }

const aliceAuthProvider = new LocalFirstAuthProvider(aliceContext)

const repo = new Repo({
  network: [SomeNetworkAdapter],
  storage: SomeStorageAdapter,
  auth: aliceAuthProvider,
})
```

The context for authentication is a localfirst/auth `Team`. For example, Alice might create a team
and invite Bob to it.

```ts
// Alice creates a team
const aliceTeam = Auth.createTeam("team A", aliceContext)
aliceAuthProvider.addTeam(aliceTeam)

// Alice creates an invitation code to send to Bob
const { seed: bobInviteCode } = aliceTeam.inviteMember()
```

Alice now needs to communicate this code, along with the team's ID, to Bob, using an existing
communications channel that she trusts. For example, she could send it via WhatsApp or Signal or
email; or she could create a QR code for Bob to scan; or she could read it to him over the phone.

Bob sets up his auth provider and his repo much like Alice did:

```ts
const bob = createUser("bob")
const bobLaptop = createDevice(bob.userId, "BOB-IPHONE-2023")
const bobContext = { user: bob, device: bobLaptop }

const bobAuthProvider = new LocalFirstAuthProvider(bobContext)

const repo = new Repo({
  network: [SomeNetworkAdapter],
  storage: SomeStorageAdapter,
  auth: bobAuthProvider,
})
```

Rather than add a `Team` to the provider, Bob registers his invitation:

```ts
bobAuthProvider.addInvitation({
  shareId: aliceTeam.id,
  invitationSeed: bobInviteCode,
})
```

If all goes well, Alice's repo and Bob's repo will each receive a `peer` event, just like without
the auth provider -- but with an authenticated peer on the other end, and an encrypted channel for
communication.

Here's how that works under the hood:

- The `LocalFirstAuthProvider` wraps the network adapter so it can intercept its messages and
  events.
- When the adapter connects and emits a `peer-candidate` event, we run the localfirst/auth
  connection protocol over that channel.
- In this case, Bob sends Alice cryptographic proof that he has the invitation code; and Alice can
  use that proof to validate his invitation and admit him to the team. He gives her his public keys,
  which she records on the team.
- Alice then sends him the team's serialized graph, so he has a complete copy. He can use this to
  verify that this is in fact the team he was invited to, and to obtain Alice's public keys.
- Alice and Bob use each other's public keys to exchange asymmetrically encrypted seed information
  and agree on a session key, which they begin using to symmetrically encrypt further communication.
- Once that is done, the authenticated network adapter re-emits the `peer-candidate` event to the
  network subsystem.

The repo can then go about its business of synchronizing documents, but with the assurance that
every peer ID reported by the network has been authenticated, and that all traffic is also
authenticated and safe from eavesdropping.

##
