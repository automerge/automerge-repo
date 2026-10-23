import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
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
  let abort: AbortController
  let disconnected: Mock<(cause: unknown) => void>
  beforeEach(() => {
    vi.stubGlobal("WebSocket", TestWebSocket)
    TestWebSocket.sockets = []
    abort = new AbortController()
    disconnected = vi.fn()
  })
  afterEach(() => {
    abort.abort()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  function open() {
    return openTransport(
      new URL("ws://localhost:8080"),
      abort.signal,
      disconnected
    )
  }

  it("resolves after open, buffers ordered binary frames, and disconnects once", async () => {
    const opening = open()
    const socket = TestWebSocket.sockets[0]
    expect(socket.binaryType).toBe("arraybuffer")
    socket.onmessage!({ data: new Uint8Array([1]).buffer })
    socket.onopen!()
    const transport = await opening
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

  it("cancels while the socket is still opening", async () => {
    const opening = open()
    abort.abort(new Error("cancelled"))
    await expect(opening).rejects.toThrow("cancelled")
    expect(TestWebSocket.sockets[0].close).toHaveBeenCalledOnce()
  })

  it("cancels a stalled handshake by rejecting pending receives", async () => {
    const opening = open()
    TestWebSocket.sockets[0].onopen!()
    const transport = await opening
    const pending = expect(transport.recvBytes()).rejects.toThrow("cancelled")
    abort.abort(new Error("cancelled"))
    await pending
    expect(TestWebSocket.sockets[0].close).toHaveBeenCalledOnce()
    expect(disconnected).toHaveBeenCalledOnce()
  })

  it("rejects a server close before open", async () => {
    const opening = open()
    TestWebSocket.sockets[0].onclose!()
    await expect(opening).rejects.toThrow("closed")
  })

  it("rejects non-binary frames and clears socket handlers", async () => {
    const opening = open()
    const socket = TestWebSocket.sockets[0]
    socket.onopen!()
    const transport = await opening
    const pending = expect(transport.recvBytes()).rejects.toThrow("binary")
    socket.onmessage!({ data: "unexpected text" })
    await pending
    expect(socket.close).toHaveBeenCalledOnce()
    expect(socket.onmessage).toBeNull()
    expect(socket.onclose).toBeNull()
  })
})
