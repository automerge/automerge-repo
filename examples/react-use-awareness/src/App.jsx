import {
  useDocument,
  useLocalAwareness,
  useRemoteAwareness,
  useBootstrap,
} from "@automerge/automerge-repo-react-hooks";

export function App({ userId }) {
  const handle = useBootstrap();
  const [doc, changeDoc] = useDocument(handle.url);

  const [localState, updateLocalState] = useLocalAwareness({
    handle,
    userId,
    initialState: {}
  });
  
  const [peerStates, heartbeats] = useRemoteAwareness({
    handle, 
    localUserId: userId,
  });

  const newCount = localState?.count;
  const count = doc?.count ?? 0;

  return (
    <div>
      <input
        type="number"
        value={newCount ?? count}
        placeholder={count}
        style={{ color: newCount ? "red" : "black" }}
        onChange={(e) =>
          updateLocalState((state) => ({
            ...state,
            count: e.target.value,
          }))
        }
      />
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
          changeDoc((doc) => {
            if (newCount === undefined) return;
            doc.count = newCount
            updateLocalState((state) => ({ ...state, count: undefined }));
          })
        }
        disabled={newCount === undefined}
        children="commit"
      />
      <button
        onClick={() =>
          updateLocalState((state) => ({ ...state, count: undefined }))
        }
        disabled={newCount === undefined}
        children="reset"
      />
      <pre>
        {JSON.stringify({ doc, localState, peerStates, heartbeats }, null, 2)}
      </pre>
    </div>
  );
}
