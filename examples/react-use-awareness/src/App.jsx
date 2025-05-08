import {
  useDocument,
  useLocalAwareness,
  useRemoteAwareness,
} from "@automerge/react"

export function App({ userId, url }) {
  const [doc, changeDoc] = useDocument(url)

  const [localState, updateLocalState] = useLocalAwareness({
    handle,
    userId,
    initialState: {},
  })

  const [peerStates, heartbeats] = useRemoteAwareness({
    handle,
    localUserId: userId,
  })

  const newCount = localState?.count
  const count = doc?.count ?? 0

  return (
    <div>
      <p>
        This is an example of useAwareness, which is used to share ephemeral
        state that won't be saved to the document. It's most commonly used for
        showing which peers are online and their cursor positions, but you can
        use any serializable data you'd like.
      </p>
      <hr />
      <div>
        Ephemeral state:
        <input
          type="number"
          value={newCount ?? count}
          placeholder={count}
          style={{ color: newCount ? "red" : "black" }}
          onChange={e =>
            updateLocalState(state => ({
              ...state,
              count: e.target.value,
            }))
          }
        />
      </div>
      <div>
        Doc state:
        <span
          children={count}
          style={{ display: "inline-block", backgroundColor: "silver" }}
        />
      </div>
      <div>
        Peer states:
        {Object.entries(peerStates).map(([peerId, { count } = {}]) => (
          <span
            key={peerId}
            style={{ backgroundColor: "silver", marginRight: "2px" }}
          >
            {peerId}: {count ?? "🤷‍♀️"}
          </span>
        ))}
      </div>
      <br />
      <button
        onClick={() =>
          changeDoc(doc => {
            if (newCount === undefined) return
            doc.count = newCount
            updateLocalState(state => ({ ...state, count: undefined }))
          })
        }
        disabled={newCount === undefined}
        children="commit to doc"
      />
      <button
        onClick={() =>
          updateLocalState(state => ({ ...state, count: undefined }))
        }
        disabled={newCount === undefined}
        children="reset"
      />
      <pre>
        {JSON.stringify({ doc, localState, peerStates, heartbeats }, null, 2)}
      </pre>
    </div>
  )
}
