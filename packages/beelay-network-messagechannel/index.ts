import { beelay } from "@automerge/automerge/slim"

export function connectMessageChannel(
  beelay: beelay.Beelay,
  port: MessagePort,
  theirPeerId: string
) {
  let stream = beelay.createStream({
    direction: "connecting",
    remoteAudience: {
      type: "peerId",
      peerId: theirPeerId,
    },
  })
  stream.on("message", message => {
    port.postMessage(message)
  })
  port.onmessage = event => {
    stream.recv(new Uint8Array(event.data))
  }
  stream.on("disconnect", () => {
    port.close()
  })
  port.start()
}

export function acceptMessageChannel(beelay: beelay.Beelay, port: MessagePort) {
  let stream = beelay.createStream({
    direction: "accepting",
  })
  stream.on("message", message => {
    port.postMessage(message)
  })
  port.onmessage = event => {
    stream.recv(new Uint8Array(event.data))
  }
  stream.on("disconnect", () => {
    port.close()
  })
  port.start()
}
