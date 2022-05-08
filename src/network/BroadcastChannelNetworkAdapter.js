class BroadcastChannelNetworkAdapter extends EventTarget {
  // we should probably pass this in and de-dupe connections hm.
  channels = {}

  constructor() {
    super()
  }

  connect(clientId) {
    this.clientId = clientId
  }

  join(documentId) {
    const docIdChannel = new BroadcastChannel('doc-'+documentId)
    docIdChannel.postMessage({origin: this.clientId, type: "arrive"})
    docIdChannel.addEventListener('message', (e) => {
      const { origin, destination, type, message } = e.data
      if (destination && destination != this.clientId) {
        return
      }
      switch(type) {
        case "arrive":
          docIdChannel.postMessage({ origin: this.clientId, destination: origin, type: "welcome"})
          // establish a connection
          let connection = {
            isOpen: () => true,
            send: (msg) => {
              const outbound = { 
                origin: this.clientId, destination: origin, type: "message", message: msg.buffer}
              docIdChannel.postMessage(outbound)
            }
          };
          this.dispatchEvent(
            new CustomEvent("peer", {
              detail: { peerId: origin, documentId, connection },
            })
          );

          break
        case "welcome":
          let connection2 = {
            isOpen: () => true,
            send: (msg) => docIdChannel.postMessage({ 
              origin: this.clientId, destination: origin, type: "message", message: msg.buffer}),
          };
          this.dispatchEvent(
            new CustomEvent("peer", {
              detail: { peerId: origin, documentId, connection: connection2 },
            })
          );
          break
        case "message":
          this.dispatchEvent(new CustomEvent('message', { detail: { peerId: origin, documentId, message: new Uint8Array(message) } }))
          break
      }
    })
  }

  leave(docId) {
    // TODO
  }
}

export default BroadcastChannelNetworkAdapter
