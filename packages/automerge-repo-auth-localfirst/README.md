<img src="https://raw.githubusercontent.com/local-first-web/branding/main/svg/auth-h.svg"
width="300" alt="@localfirst/auth logo" />

# Local-first auth provider for Automerge Repo

This is an `AuthProvider` that uses the [localfirst/auth](https://github.com/local-first-web/auth)
library to provide Automerge Repo with authentication and end-to-end encryption.

## Configuration

A `LocalFirstAuthProvider` is configured with information about the local user and device.

```ts
import { createUser, createDevice } from "@localfirst/auth"
import { LocalFirstAuthProvider } from "@automerge/automerge-repo-auth-localfirst"

// Create the user & device, or retrieve them from storage.
// These objects include secret keys, so need to be stored securely.
const user = createUser("alice")
const device = createDevice(user.userId, "ALICE-MACBOOK-2023")

const auth = new LocalFirstAuthProvider({ user, device })

const repo = new Repo({ network, storage, auth })
```

### Saving provider state to storage

```ts
const savedState = auth.getState()
// Persist `savedState` to the storage medium of your choice
```

### Loading provider from stored state

```ts
const savedState = // ... retrieve from storage
const auth = new LocalFirstAuthProvider({ user, device, source: savedState })
```

## Shares

A "share" represents one or more documents that are shared with one or more other people. A share might include many documents shared with a long-lasting entity like a team. Or, it might represent a single document being shared with one other person.

### Create a new share

When you create a share, you'll get back a unique ID.

```ts
const shareId = auth.createShare()
```

### Join an existing share

You'll need the `shareId` as well as an invitation seed.

```ts
auth.joinShare({ shareId, invitationSeed })
```

### Invite someone to a share

```ts
const { id, seed } = auth.inviteMember(shareId)
```

Send `seed` to the person you're inviting (along with the `shareId`) via a side channel (e.g. email, Signal, QR code). You can use `id` to revoke the invitation.

### Look up members

```ts
// Retrieve the full list of members
const members = auth.members(shareId)

// Retrieve a specific member
const bob = auth.members(shareId, "bob")
```

### Invite a device

```ts
const { id, seed } = auth.inviteDevice(shareId)
```

Send `seed` and `shareId` to the device by a side channel (e.g. bluetooth, QR code). You can use `id` to revoke the invitation.

### Add a known user to a share

If you already have a user's ID and public keys (e.g. because you've shared something else with them via an invitation), you can add them directly to a share.

```ts
auth.addMember({ shareId, user })
```

### Add a known device to a share

Likewise, if you have already shared something with a device, you can add it directly to a share.

```ts
auth.addDevice({ shareId, device })
```

## Documents & permissions

### Add documents to a share

```ts
const documentIds = [documentId1, documentId2]
auth.addDocument({ shareId, documentIds })
```

All documents must be added explicitly. If some documents reference other documents, you'll need to add the referenced documents as well.

By default, all documents can be read and written by all share members. To limit access to documents by role, specify one or more roles when adding the documents:

```ts
const roles = ["ADMIN", "MANAGEMENT"]
auth.addDocument({ shareId, documentIds, roles })
```

When specified this way, any member of any of these roles will have both read and write permissions. To set separate read and write permissions, pass an object with `read` and (optionally) `write` properties:

```ts
const roles = {
  read: ["OPERATIONS", "SUPPORT"],
  write: "MANAGEMENT",
}
```

Any roles with `write` permission automatically have `read` permissions.

If no `write` roles are provided, only you will be able to make changes to the document.

### Set permissions on a document

You can change permissions on a document or group of documents at any time:

```ts
auth.setRoles({ documentId, roles })
```
