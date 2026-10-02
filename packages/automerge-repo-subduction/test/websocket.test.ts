import * as N from "@automerge/subduction"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from "vitest"
import { openTransport } from "../src/websocket.js"

class TestWebSocket {
  static sockets: TestWebSocket[] = []
  binaryType = "blob"
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  close = vi.fn()
  send = vi.fn()
  constructor(readonly url: URL) {
    TestWebSocket.sockets.push(this)
  }
}

describe("owned WebSocket transport", () => {
  let signer: N.MemorySigner
  let abort: AbortController
  let handshake: MockInstance<typeof N.AuthenticatedTransport.setupDiscover>
  let authenticated: N.AuthenticatedTransport
  let disconnected: Mock<(cause: unknown) => void>
  beforeEach(() => {
    vi.stubGlobal("WebSocket", TestWebSocket)
    TestWebSocket.sockets = []
    signer = N.MemorySigner.generate()
    abort = new AbortController()
    disconnected = vi.fn()
    authenticated = { free: vi.fn() } as unknown as N.AuthenticatedTransport
    handshake = vi
      .spyOn(N.AuthenticatedTransport, "setupDiscover")
      .mockResolvedValue(authenticated)
  })
  afterEach(() => {
    abort.abort()
    signer.free()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  function open() {
    return openTransport(
      new URL("ws://localhost:8080"),
      signer,
      "localhost:8080",
      abort.signal,
      disconnected
    )
  }

  it("authenticates after open, buffers ordered binary frames, and disconnects once", async () => {
    const opening = open()
    const socket = TestWebSocket.sockets[0]
    expect(socket.binaryType).toBe("arraybuffer")
    expect(handshake).not.toHaveBeenCalled()
    socket.onmessage!({ data: new Uint8Array([1]).buffer })
    socket.onopen!()
    expect(await opening).toBe(authenticated)
    expect(handshake).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      "localhost:8080"
    )
    expect(handshake.mock.calls[0][1].verifyingKey()).toEqual(
      signer.verifyingKey()
    )
    const transport = handshake.mock.calls[0][0]
    expect(await transport.recvBytes()).toEqual(new Uint8Array([1]))
    const next = transport.recvBytes()
    socket.onmessage!({ data: new Uint8Array([2]).buffer })
    expect(await next).toEqual(new Uint8Array([2]))
    await transport.sendBytes(new Uint8Array([3]))
    expect(socket.send).toHaveBeenCalledWith(new Uint8Array([3]))
    const callback = vi.fn()
    transport.onDisconnect(callback)
    const pending = expect(transport.recvBytes()).rejects.toThrow(
      "disconnected"
    )
    await transport.disconnect()
    await pending
    await transport.disconnect()
    abort.abort()
    expect(socket.close).toHaveBeenCalledOnce()
    expect(disconnected).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledOnce()
    await expect(transport.sendBytes(new Uint8Array())).rejects.toThrow(
      "disconnected"
    )
  })

  it("closes on handshake rejection", async () => {
    handshake.mockRejectedValueOnce(new Error("handshake denied"))
    const opening = open()
    const socket = TestWebSocket.sockets[0]
    socket.onopen!()
    await expect(opening).rejects.toThrow("handshake denied")
    expect(socket.close).toHaveBeenCalledOnce()
    expect(disconnected).toHaveBeenCalledOnce()
  })

  it("cancels while the socket is still opening", async () => {
    const opening = open()
    abort.abort(new Error("cancelled"))
    await expect(opening).rejects.toThrow("cancelled")
    expect(handshake).not.toHaveBeenCalled()
    expect(TestWebSocket.sockets[0].close).toHaveBeenCalledOnce()
  })

  it("cancels a stalled handshake by rejecting pending receives", async () => {
    handshake.mockImplementationOnce(async transport => {
      await transport.recvBytes()
      return authenticated
    })
    const opening = open()
    TestWebSocket.sockets[0].onopen!()
    await Promise.resolve()
    abort.abort(new Error("cancelled"))
    await expect(opening).rejects.toThrow("cancelled")
    expect(TestWebSocket.sockets[0].close).toHaveBeenCalledOnce()
  })

  it("cancels a real native handshake even while an asynchronous signer is stalled", async () => {
    handshake.mockRestore()
    let finishSigning!: (signature: Uint8Array) => void
    const sign = vi.spyOn(signer, "sign").mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishSigning = resolve
        })
    )
    const opening = open()
    TestWebSocket.sockets[0].onopen!()
    await vi.waitFor(() => expect(sign).toHaveBeenCalledOnce())
    const message = sign.mock.calls[0][0]
    abort.abort(new Error("signer cancelled"))
    await expect(opening).rejects.toBeDefined()
    expect(TestWebSocket.sockets[0].close).toHaveBeenCalledOnce()
    sign.mockRestore()
    finishSigning(await signer.sign(message))
    await Promise.resolve()
    expect(TestWebSocket.sockets[0].send).not.toHaveBeenCalled()
  })

  it("rejects a server close before open", async () => {
    const opening = open()
    TestWebSocket.sockets[0].onclose!()
    await expect(opening).rejects.toThrow("closed")
    expect(handshake).not.toHaveBeenCalled()
  })

  it("turns signer rejection into a transport failure rather than a native panic", async () => {
    handshake.mockRestore()
    vi.spyOn(signer, "sign").mockRejectedValueOnce(new Error("signing failed"))
    const opening = open()
    TestWebSocket.sockets[0].onopen!()
    await expect(opening).rejects.toBeDefined()
    expect(TestWebSocket.sockets[0].close).toHaveBeenCalledOnce()
    expect(TestWebSocket.sockets[0].send).not.toHaveBeenCalled()
  })

  it.each([null, Array(64).fill(0), new Uint8Array(32)])(
    "rejects malformed signer results without panicking native code: %s",
    async signature => {
      handshake.mockRestore()
      vi.spyOn(signer, "sign").mockResolvedValueOnce(signature as Uint8Array)
      const opening = open()
      TestWebSocket.sockets[0].onopen!()
      await expect(opening).rejects.toBeDefined()
      expect(TestWebSocket.sockets[0].close).toHaveBeenCalledOnce()
      expect(TestWebSocket.sockets[0].send).not.toHaveBeenCalled()
    }
  )

  it("rejects non-binary frames and clears socket handlers", async () => {
    const opening = open()
    const socket = TestWebSocket.sockets[0]
    socket.onopen!()
    await opening
    const pending = expect(
      handshake.mock.calls[0][0].recvBytes()
    ).rejects.toThrow("binary")
    socket.onmessage!({ data: "unexpected text" })
    await pending
    expect(socket.close).toHaveBeenCalledOnce()
    expect(socket.onmessage).toBeNull()
    expect(socket.onclose).toBeNull()
  })
})
