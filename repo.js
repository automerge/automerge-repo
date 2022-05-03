
// Saving & loading
// How should we think about incremental save & load? Log + compaction? TBD.

export const storageInterface = { 
    load: (docId) => localforage.getItem(docId),
    save: (docId, binary) => localforage.setItem(docId, binary).catch(err => console.log(err))
  }
  
  
import { Client } from "./Client.js"
  
export function networkInterface(url, onPeer, onMessage) {
    const client = new Client({ userName: `user-${Math.round(Math.random()*1000)}`, url })
    
    client.addEventListener('peer.connect', (ev) => {
      const {documentId, userName, socket} = ev.detail
      socket.binaryType = 'arraybuffer'
      onPeer(userName, documentId, {
        isOpen: () => socket.readyState === WebSocket.OPEN,
        send: (msg) => socket.send(msg.buffer)
      })
  
      // listen for messages
      socket.onmessage = (e) => {
          console.log(e.data)
        const message = new Uint8Array(e.data)
        onMessage(userName, documentId, message)
      }
    })
  
    return {
      join: (docId) => { client.join(docId) },
    }
  }
  
  export function newRepo(storage, networkInterface, url) {
    const peers = {}
    const docs = {}
  
    // when we discover a peer for a document
    // we set up a syncState, then send an initial sync message to them
    const onPeer = (peerId, documentId, connection) => {
      let syncState, msg;
      peers[peerId] = { connection, syncStates: {} }
  
      // Start sync by sending a first message.
      // TODO: load syncState from localStorage if available

      ;[syncState, msg] = Automerge.generateSyncMessage(docs[documentId], Automerge.initSyncState())
      peers[peerId].syncStates[documentId] = syncState
      if (msg) { connection.send(msg) }
    }
  
    // when we hear from a peer, we receive the syncMessage
    // and then see if we need to reply to them (or anyone else)
    const onMessage = (peerId, documentId, message) => {
      let syncState = peers[peerId].syncStates[documentId]
      let doc = docs[documentId]
      ;[doc, syncState] = Automerge.receiveSyncMessage(doc, syncState, message)
      peers[peerId].syncStates[documentId] = syncState
      docs[documentId] = doc
      syncWithPeers(documentId, doc)
    }
  
    function syncWithPeers(documentId, doc) {
      // could do something nicer than this jank
      Object.values(peers).forEach( ({connection, syncStates}) => {
        if (!connection.isOpen()) { return }
        let msg
        let syncState = syncStates[documentId]
        ;[syncState, msg] = Automerge.generateSyncMessage(doc, syncState)
        syncStates[documentId] = syncState // this is an object reference, so works as expected
        if (msg) { 
          connection.send(msg) 
        }
      })
    }
  
    const { join } = networkInterface(url, onPeer, onMessage)
  
    const save = (docId, doc) => {
      const binary = Automerge.save(doc)
      storage.save(docId, binary) 
    }
  
    return {
      change: (docId, callback) => {
        docs[docId] = Automerge.change(docs[docId], callback)
        save(docId, docs[docId])
        syncWithPeers(docId, docs[docId])
        return docs[docId]
      },
      load: async (docId) => {
        const binary = await storage.load(docId)
        join(docId)
        if (!binary) return null
        docs[docId] = Automerge.load(binary)
        return docs[docId]
      },
    }
  }
  