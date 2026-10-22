import { DummyNetworkAdapter } from "../../src/helpers/DummyNetworkAdapter.js"
import { Repo } from "../../src/Repo.js"
import { whenPeersConnected } from "./whenPeerConnected.js"

export default async function connectRepos(left: Repo, right: Repo) {
  const [leftToRight, rightToLeft] = DummyNetworkAdapter.createConnectedPair({
    latency: 0,
  })
  left.networkSubsystem.addNetworkAdapter(leftToRight)
  right.networkSubsystem.addNetworkAdapter(rightToLeft)
  leftToRight.peerCandidate(right.peerId)
  rightToLeft.peerCandidate(left.peerId)
  await whenPeersConnected(left, right)
}
