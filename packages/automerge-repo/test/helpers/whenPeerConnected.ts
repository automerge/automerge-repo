import type { Repo } from "../../src/Repo.js"
import type { PeerId } from "../../src/types.js"

/**
 * Resolves once `repo` has registered `peerId`.
 *
 * Not `networkSubsystem.whenReady()`, which can resolve on a timeout fallback
 * with no peer registered. Filtered by peer, since a repo with several links
 * emits `peer` for whichever answers first.
 */
export function whenPeerConnected(repo: Repo, peerId: PeerId): Promise<void> {
  if (repo.peers.includes(peerId)) return Promise.resolve()
  return new Promise(resolve => {
    const onPeer = ({ peerId: arrived }: { peerId: PeerId }) => {
      if (arrived !== peerId) return
      repo.networkSubsystem.off("peer", onPeer)
      resolve()
    }
    repo.networkSubsystem.on("peer", onPeer)
  })
}

/** Both directions of a link between two repos. */
export function whenPeersConnected(left: Repo, right: Repo): Promise<void[]> {
  return Promise.all([
    whenPeerConnected(left, right.peerId),
    whenPeerConnected(right, left.peerId),
  ])
}
