import { AutomergeUrl } from "@automerge/automerge-repo"
import { useCollection, useRepo } from "@automerge/automerge-repo-react-hooks"
import { useEffect, useState } from "react"
import AppContent from "./AppContent"

function useIsConnected() {
  const repo = useRepo()
  const [isConnected, setIsConnected] = useState(repo.peers.length > 0)
  useEffect(() => {
    console.log('setting up isConnected')
    function peerListener() {
      console.log("peer count changed to: ", repo.peers.length)
      setIsConnected(repo.peers.length > 0)
    }
    repo.networkSubsystem.on("peer", peerListener)
    repo.networkSubsystem.on("peer-disconnected", peerListener)
    return () => {
      repo.networkSubsystem.off("peer", peerListener)
      repo.networkSubsystem.off("peer-disconnected", peerListener)
    }
  }, [repo])
  return isConnected
}

export default function App({docUrl}: {docUrl: AutomergeUrl }) {
  console.log('here')
  const isConnected = useIsConnected()
  const collectionProgress = useCollection(docUrl)
  const [showSync, setShowSync] = useState(false)
  const [showApp, setShowApp] = useState(false)
  console.log("collection status: ", `${collectionProgress.type}`)

  if (!isConnected && !showSync) {
    return <div>
      <p>Not connected to any peers, click to continue regardless</p>
      <button onClick={() => setShowSync(true)}>Show Sync</button>
    </div>
  }

  if (collectionProgress.type !== "done") {
    return <div>Loading...</div>
  } else if (!showApp) {
    return <div>
      <button onClick={() => setShowApp(true)}>Show App</button>
    </div>
  } else {
    return <AppContent docUrl={docUrl} />
  }
}
