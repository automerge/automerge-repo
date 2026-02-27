import {
  AutomergeUrl,
  PeerId,
  PeerState,
  PeerStateView,
  useDocHandle,
  useDocument,
  usePresence,
} from "@automerge/react"

type State = { count: number | undefined }

export function App({ userId, url }: { userId: string; url: AutomergeUrl }) {
  const handle = useDocHandle(url, { suspense: true })
  const [doc, changeDoc] = useDocument<State>(url)
  const { localState, peerStates, update } = usePresence<State>({
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
          placeholder={String(count)}
          style={{ color: newCount ? "red" : "black" }}
          onChange={e => update("count", parseInt(e.target.value, 10))}
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
        {peerStates.peers.map(state => (
          <span
            key={state.peerId}
            style={{ backgroundColor: "silver", marginRight: "2px" }}
          >
            {state.peerId}: {JSON.stringify(state.value?.count ?? "🤷‍♀️")}
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
          {
            doc,
            localState,
            peerStates: peerStates.peers.map(state => state.value),
          },
          null,
          2
        )}
      </pre>
    </div>
  )
}
