import { DummyNetworkAdapter } from "../../src/helpers/DummyNetworkAdapter.js"
import { Repo, ShareConfig, SharePolicy } from "../../src/Repo.js"
import { PeerId } from "../../src/types.js"
import connectRepos from "./connectRepos.js"

// The parts of `RepoConfig` which are either the old sharePolicy API or the new shareConfig API
export type EitherConfig = {
  sharePolicy?: SharePolicy
  shareConfig?: ShareConfig
}

/// Create two connected peers with the given share configurations
export default async function twoPeers({
  alice: aliceConfig,
  bob: bobConfig,
}: {
  alice: EitherConfig
  bob: EitherConfig
}): Promise<{ alice: Repo; bob: Repo }> {
  const alice = new Repo({
    peerId: "alice" as PeerId,
    ...aliceConfig,
  })
  const bob = new Repo({
    peerId: "bob" as PeerId,
    ...bobConfig,
  })
  await connectRepos(alice, bob)
  return { alice, bob }
}
