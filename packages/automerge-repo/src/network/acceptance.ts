import { NetworkAdapter } from "./NetworkAdapter"

export const testNetworkAdapter = (
  aliceAdapter: NetworkAdapter,
  bobAdapter: NetworkAdapter
) => {
  // set up two repos and connect them using the network adapter
  // const aliceRepo = new Repo({ network: aliceAdapter })
  // const bobRepo = new Repo({ network: bobAdapter })
}

// ... in the adapter's test suite:

// import { testNetworkAdapter } from "automerge-repo/test/network"

// const aliceAdapter = new TestNetworkAdapter(....)
// const bobAdapter = new TestNetworkAdapter(....)

// test("acceptance", () => { testNetworkAdapter(aliceAdapter, bobAdapter) }
