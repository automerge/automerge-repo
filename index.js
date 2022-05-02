/* document data model as pseudo-typescript:

interface TodoItem {
    text: string;
    done: boolean;
}

interface Document {
    items: TodoItem[];
}

*/

function addItem(text) {
    let newDoc = Automerge.change(doc, doc => {
      if (!doc.items) doc.items = []
      doc.items.push({ text, done: false })
    })
    updateDoc(newDoc)
}

function toggleItem(i) {
    let newDoc = Automerge.change(doc, doc => {
        doc.items[i].done = !doc.items[i].done
    })
    updateDoc(newDoc)
}

function updateDoc(newDoc) {
    doc = newDoc
    console.log(Automerge.decodeChange(Automerge.getLastLocalChange(newDoc)).ops)
    render(newDoc)
    // save(newDoc)
    syncWithPeers(newDoc)
}

function render(doc) {
  if (!doc) { return }
  let list = document.querySelector("#todo-list")
  list.innerHTML = ''
  doc.items && doc.items.forEach((item, index) => {
    let itemEl = document.createElement('li')
    itemEl.innerText = item.text
    itemEl.style = item.done ? 'text-decoration: line-through' : ''
    itemEl.onclick = function() {
        toggleItem(index)
    }
    list.appendChild(itemEl)
  })
}

let form = document.querySelector("form")
let input = document.querySelector("#new-todo")
form.onsubmit = (ev) => {
  ev.preventDefault()
  addItem(input.value)
  input.value = null
}

// Saving & loading
// How should we think about incremental save & load? Log + compaction? TBD.

const storageInterface = { 
  load: (docId) => localforage.getItem(docId),
  save: (docId, binary) => localforage.setItem(docId, binary).catch(err => console.log(err))
}

let repo = {
  load: async (storage, docId) => {
    const binary = await storage.load(docId)
    if (!binary) return null
    return Automerge.load(binary)
  },
  save: (storage, docId, doc) => {
    const binary = Automerge.save(doc)
    storage.save(docId, binary) 
  }
}

let docId = "my-todo-list" // arbitrary name
let doc = await repo.load(storageInterface, docId)
if (!doc) { doc = Automerge.init() }
render(doc)

import { Client } from "./Client.js"
const url = "ws://localhost:8080"

const peers = {}
const peerSockets = {}

const client = new Client({ userName: `user-${Math.round(Math.random()*1000)}`, url })
  .join(docId)
  .addEventListener('peer.connect', (ev) => {
    const {documentId, userName, socket} = ev.detail
    peerSockets[userName] = socket
    socket.binaryType = 'arraybuffer'

    // send a message
    let msg;
    [peers[userName], msg] = Automerge.generateSyncMessage(doc, peers[userName] || Automerge.initSyncState())
    if (msg) {
      socket.send(msg.buffer)
    }

    // listen for messages
    socket.onmessage = (e) => {
      
      e.target.binaryType = 'arraybuffer';
      console.log(typeof e.data, e.data)
      if (typeof e.data === "string") { throw new Error("WTF")}

      const message = new Uint8Array(e.data)
      console.log(message)
      let nextState
      [doc, nextState] = Automerge.receiveSyncMessage(
        doc, 
        peers[userName] || Automerge.initSyncState(),
        message)
      peers[userName] = nextState
        
      syncWithPeers(doc, peers)
      render(doc)
    }
  })

  function syncWithPeers(doc) {
    // could do something nicer than this jank
    Object.entries(peers).forEach( ([peerName, syncState]) => {
      if (peerSockets[peerName].readyState !== WebSocket.OPEN) {
        return
      } 
      let nextState, msg
      [nextState, msg] = Automerge.generateSyncMessage(doc, syncState)
      peers[peerName] = nextState
      if (msg) { 
        const s = peerSockets[peerName]
        s.send(msg.buffer) 
      }
    })
  }