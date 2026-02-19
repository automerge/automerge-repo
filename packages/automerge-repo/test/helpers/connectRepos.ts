import { DummyNetworkAdapter } from "../../src/helpers/DummyNetworkAdapter.js"
import { Repo } from "../../src/Repo.js"
import { PeerId } from "../../src/types.js"
import pause from "./pause.js"

export type Connection = {
  disconnect: () => void
  reconnect: () => Promise<void>
}

export default async function connectRepos(
  left: Repo,
  right: Repo
): Promise<Connection> {
  const [leftToRight, rightToLeft] = DummyNetworkAdapter.createConnectedPair({
    latency: 0,
  })
  left.networkSubsystem.addNetworkAdapter(leftToRight)
  right.networkSubsystem.addNetworkAdapter(rightToLeft)
  leftToRight.peerCandidate(right.peerId)
  rightToLeft.peerCandidate(left.peerId)
  await Promise.all([
    left.networkSubsystem.whenReady(),
    right.networkSubsystem.whenReady(),
  ])
  await pause(10)

  return {
    disconnect: () => {
      leftToRight.emit("peer-disconnected", { peerId: right.peerId as PeerId })
      rightToLeft.emit("peer-disconnected", { peerId: left.peerId as PeerId })
    },
    reconnect: async () => {
      leftToRight.peerCandidate(right.peerId)
      rightToLeft.peerCandidate(left.peerId)
      await Promise.all([
        left.networkSubsystem.whenReady(),
        right.networkSubsystem.whenReady(),
      ])
      await pause(10)
    },
  }
}
