import React from "react"

import { PeerId, Repo } from "@automerge/automerge-repo"
import "@testing-library/jest-dom"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"
import { RepoContext } from "../src/useRepo"
import { DummyNetworkAdapter } from "../src/helpers/DummyNetworkAdapter"

afterEach(() => {
  cleanup()
})

export interface ExampleDoc {
  foo: string
  counter?: number
  nested?: {
    value: string
  }
}

export function setup(latency = 100) {
  const [adapterBob, adapterServer] = DummyNetworkAdapter.createConnectedPair({
    latency,
  })

  const peerIdBob = "bob" as PeerId
  const peerIdServer = "server" as PeerId
  const repo = new Repo({
    peerId: peerIdBob,
    network: [adapterBob],
  })

  const remoteRepo = new Repo({
    peerId: peerIdServer,
    network: [adapterServer],
  })

  adapterBob.peerCandidate(peerIdServer)
  adapterServer.peerCandidate(peerIdBob)

  const handleA = repo.create<ExampleDoc>()
  handleA.change(doc => (doc.foo = "A"))

  const handleB = repo.create<ExampleDoc>()
  handleB.change(doc => (doc.foo = "B"))

  const handleC = repo.create<ExampleDoc>()
  handleC.change(doc => (doc.foo = "C"))

  const remoteHandleD = remoteRepo.create<ExampleDoc>()
  remoteHandleD.change(doc => (doc.foo = "D"))

  const remoteHandleE = remoteRepo.create<ExampleDoc>()
  remoteHandleE.change(doc => (doc.foo = "E"))

  const wrapper = ({ children }) => {
    return <RepoContext.Provider value={repo}>{children}</RepoContext.Provider>
  }

  return {
    repo,
    handleA,
    handleB,
    handleC,
    nonLocalDocUrlD: remoteHandleD.url,
    nonLocalDocUrlE: remoteHandleE.url,
    handles: [handleA, handleB, handleC],
    urls: [handleA.url, handleB.url, handleC.url],
    wrapper,
  }
}

export function setupPairedRepos(latency = 10) {
  // Create two connected repos with network delay
  const [adapterCreator, adapterFinder] =
    DummyNetworkAdapter.createConnectedPair({
      latency,
    })

  const peerIdCreator = "peer-creator" as PeerId
  const peerIdFinder = "peer-finder" as PeerId
  const repoCreator = new Repo({
    peerId: peerIdCreator,
    network: [adapterCreator],
  })
  const repoFinder = new Repo({
    peerId: peerIdFinder,
    network: [adapterFinder],
  })

  // TODO: dummynetwork adapter should probably take care of this
  // Initialize the network.
  adapterCreator.peerCandidate(peerIdFinder)
  adapterFinder.peerCandidate(peerIdCreator)

  function Wrapper({ children }) {
    return (
      <RepoContext.Provider value={repoFinder}>{children}</RepoContext.Provider>
    )
  }

  return { repoCreator, repoFinder, wrapper: Wrapper }
}
