/* eslint-disable no-undef */
/* eslint-disable no-param-reassign */
/* eslint-disable no-use-before-define */
/* eslint-disable no-shadow */
import '../vendor/localforage.js'

/* The key interfaces here are peer & message
 * The Network joins Channels which have Peers. Peers send messages.
 * (This has been a hard decision -- do messages come from peers or channels?)
 * Right now, messages are passed directly to a doc-decoder based on their channel ID.
 * They should pass through a message parsing step.
 */

// TODO:
// end-to-end encryption (authenticating peers)
// multiple documents
// "drafts" of documents per upwelling (offers)
// PSI -> sharing documents you have in common with a peer
// "offers" so storage peers will save your stuff
// persistent share lists for storage peer

import Repo from '../src/Repo.js'
import StorageAdapter from '../src/storage/interfaces/LocalForageStorageAdapter.js'
import BCNetworkAdapter from '../src/network/interfaces/BroadcastChannelNetworkAdapter.js'
import LFNetworkAdapter from '../src/network/interfaces/LocalFirstRelayNetworkAdapter.js'

import Network from '../src/network/Network.js'
import StorageSystem from '../src/storage/StorageSubsystem.js'
import { ExplicitShareCollectionSynchronizer } from '../src/network/CollectionSynchronizer.js'

const storageSubsystem = new StorageSystem(StorageAdapter())
const repo = new Repo(storageSubsystem)
repo.addEventListener('document', (ev) => storageSubsystem.onDocument(ev))

const network = new Network(
  [new LFNetworkAdapter('ws://localhost:8080'), new BCNetworkAdapter()],
)

const synchronizer = new ExplicitShareCollectionSynchronizer()
network.addEventListener('peer', (ev) => synchronizer.onPeer(ev, repo))
repo.addEventListener('document', (ev) => {
  console.log("joining", ev.detail.handle.documentId)
  network.join(ev.detail.handle.documentId)
  synchronizer.onDocument(ev)
})

let docId = window.location.hash.replace(/^#/, '')
if (!docId) {
  const docName = window.location.hash.replace(/^#/, '') || 'my-todo-list'
  docId = await localforage.getItem(`docId:${docName}`)
}
let handle

if (!docId) {
  [docId, handle] = repo.create()
  localforage.setItem(`docId:${docName}`, docId)
} else {
  handle = await repo.loadOrRequest(docId)
}

// this is... gross. i don't like the whole ev.detail business but it's probably fine.
handle.addEventListener('change', () => render({ handle }))
// this is even worse and i guess is why everyone invents a framework
repo.addEventListener('document', (ev) => {
  ev.detail.handle.addEventListener('change', () => render({ handle }))
})
// this ugliness is because
// by the time we add the event listener, the event for loading the doc has already passed
render({ handle })

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
  // don't actually do this
  const [id, itemDoc] = repo.create()
  itemDoc.change((i) => {
    i.text = text
    i.done = false
  })
  handle.change((doc) => {
    if (!doc.items) doc.items = []
    doc.items.push(id)
  })
}

function toggleItem(i) {
  repo.get(handle.value().items[i]).change((i) => {
    i.done = !i.done
  })
}

const form = document.querySelector('form')
const input = document.querySelector('#new-todo')
form.onsubmit = (ev) => {
  ev.preventDefault()
  addItem(input.value)
  input.value = null
}

async function render({ handle }) {
  const doc = handle.value()
  if (!doc) { return }
  const list = document.querySelector('#todo-list')
  list.innerHTML = ''
  if (doc.items) {
    doc.items.forEach(async (itemId, index) => {
      const itemEl = document.createElement('li')
      const itemHandle = await repo.getOrLoadOrRequest(itemId)
      const item = itemHandle.value()
      if (!item) { itemEl.innerText = "BUG"; list.appendChild(itemEl); return }
      itemEl.innerText = item.text
      itemEl.style = item.done ? 'text-decoration: line-through' : ''
      itemEl.onclick = () => toggleItem(index)
      list.appendChild(itemEl)
    })
  }
}
