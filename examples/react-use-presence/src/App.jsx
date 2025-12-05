import { useDocument, usePresence } from "@automerge/react"

export function App({ userId, url }) {
  const [doc, changeDoc] = useDocument(url)
  const { localState, peerStates, update } = usePresence({
    handle,
    userId,
    initialState: { count: 0 },
  })

  const newCount = localState?.count
  const count = doc?.count ?? 0

  return (
    <div>
      <p>
        This is an example of usePresence, which is used to share ephemeral
        state that won't be saved to the document. It's most commonly used for
        showing which peers are online and their cursor positions, but you can
        use any serializable data you'd like.
      </p>
      <hr />
      <label>
        Ephemeral state:
        <input
          type="number"
          value={newCount ?? count}
          placeholder={count}
          style={{ color: newCount ? "red" : "black" }}
          onChange={e => update("count", e.target.value)}
        />
      </label>
      <div>
        Doc state:
        <span
          children={count}
          style={{ display: "inline-block", backgroundColor: "silver" }}
        />
      </div>
      <div>
        Peer states:
        {peerStates.getPeers().map(peerId => (
          <span
            key={peerId}
            style={{ backgroundColor: "silver", marginRight: "2px" }}
          >
            {peerId}: {peerStates.getPeerState(peerId, "count") ?? "🤷‍♀️"}
          </span>
        ))}
      </div>
      <br />
      <button
        onClick={() =>
          changeDoc(doc => {
            if (newCount === undefined) return
            doc.count = newCount
            update("count", undefined)
          })
        }
        disabled={newCount === undefined}
        children="commit to doc"
      />
      <button
        onClick={() => update("count", undefined)}
        disabled={newCount === undefined}
        children="reset"
      />
      <pre data-testid="peer-states">
        {JSON.stringify(
          { doc, localState, peerStates: getAllPeerStates(peerStates) },
          null,
          2
        )}
      </pre>
    </div>
  )
}

function getAllPeerStates(peerStates) {
  return peerStates.getPeers().reduce((acc, peerId) => {
    acc[peerId] = peerStates.getPeerState(peerId)
    return acc
  }, {})
}
