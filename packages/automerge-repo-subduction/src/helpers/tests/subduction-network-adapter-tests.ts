import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest"
import type * as N from "@automerge/subduction/slim"
import type {
  SubductionConnect,
  SubductionNetworkAdapterInterface,
} from "../../network/SubductionNetworkAdapterInterface.js"

export type NetworkSetupFn = () => Promise<{
  /** An adapter able to open a transport to some reachable endpoint. */
  adapter: SubductionNetworkAdapterInterface
  teardown?: () => void | Promise<void>
}>

/** Acceptance tests every `SubductionNetworkAdapterInterface` must pass.
 * `connect` is a stand-in for the backend; it speaks no protocol. */
export function runSubductionNetworkAdapterTests(
  setup: NetworkSetupFn,
  title?: string
): void {
  describe(`Subduction network adapter acceptance tests${
    title ? ` (${title})` : ""
  }`, () => {
    let adapter: SubductionNetworkAdapterInterface
    let teardown: (() => void | Promise<void>) | undefined
    let transports: N.Transport[]
    let stopped: boolean
    beforeEach(async () => {
      ;({ adapter, teardown } = await setup())
      transports = []
      stopped = false
    })
    afterEach(async () => {
      if (!stopped) await adapter.stop()
      await teardown?.()
    })

    /** Like the backend, onboarding fails once the transport disconnects. */
    function connectWith(
      outcome: "accept" | "reject" | "hang"
    ): Mock<SubductionConnect> {
      return vi.fn<SubductionConnect>(async (transport, audience) => {
        expect(audience).toBeTypeOf("object")
        transports.push(transport)
        if (outcome === "accept") return "ab".repeat(32)
        if (outcome === "reject") {
          await transport.disconnect()
          throw new Error("Onboarding refused")
        }
        return new Promise<string>((_resolve, reject) =>
          transport.onDisconnect(() =>
            reject(new Error("Transport disconnected"))
          )
        )
      })
    }

    async function stop() {
      stopped = true
      await adapter.stop()
    }

    it("resolves start once a supplied transport is accepted", async () => {
      const connect = connectWith("accept")
      await adapter.start(connect)
      expect(connect).toHaveBeenCalledOnce()
      const [transport] = transports
      for (const method of [
        "sendBytes",
        "recvBytes",
        "disconnect",
        "onDisconnect",
      ] as const)
        expect(transport[method]).toBeTypeOf("function")
    })

    it("rejects start when the first attempt fails", async () => {
      await expect(adapter.start(connectWith("reject"))).rejects.toThrow()
    })

    it("stop disconnects supplied transports and stops connecting", async () => {
      const connect = connectWith("accept")
      await adapter.start(connect)
      const disconnected = vi.fn()
      transports[0].onDisconnect(disconnected)
      await stop()
      expect(disconnected).toHaveBeenCalledOnce()
      const calls = connect.mock.calls.length
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(connect).toHaveBeenCalledTimes(calls)
    })

    it("stop settles a pending first attempt", async () => {
      const connect = connectWith("hang")
      const started = adapter.start(connect)
      await vi.waitFor(() => expect(connect).toHaveBeenCalled())
      await stop()
      await expect(started).rejects.toThrow()
    })

    it("stop settles start before any transport opens", async () => {
      const started = adapter.start(connectWith("accept"))
      await stop()
      await Promise.allSettled([started])
    })
  })
}
