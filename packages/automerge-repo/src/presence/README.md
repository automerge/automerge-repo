# Presence

`Presence` shares short-lived state, such as cursors or who is online,
through a handle's ephemeral messages.

```ts
const presence = new Presence<{ cursor: number }>({ handle })
presence.start({ initialState: { cursor: 0 } })
presence.broadcast("cursor", 3)
presence.stop()
```

It keeps one entry per sending Repo. Several Repos can share one peer, such
as browser tabs using one signer; see
[`Repo.id` and peer IDs](../../README.md#repoid-and-peer-ids).

## Handles

`Presence` takes any handle which fits the ([`PresenceHandle`](./types.ts)) interface:

- **`broadcast(message)`** sends `message` to the document's other peers. It
  encodes the message when called, so later changes to it aren't sent. It is
  best effort: a failed send is logged, not thrown.
- **An `ephemeral-message` event**, with `on` and `off`. It fires for each
  message from another Repo, and never for this Repo's own broadcasts, which
  `Presence` would take for a new peer. Its payload has:
  - `senderId`: the peer that sent it, as the backend authenticated it.
  - `originId`: the Repo that sent it. Claimed, not authenticated.
  - `message`: what the sender passed to `broadcast`.
