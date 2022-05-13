/* eslint-disable no-undef */
/* eslint-disable no-param-reassign */
/* eslint-disable no-use-before-define */
/* eslint-disable no-shadow */
import '../vendor/localforage.js'

import Repo from '../src/Repo.js'
import StorageAdapter from '../src/storage/LocalForageStorageAdapter.js'
import BCNetworkAdapter from '../src/network/BroadcastChannelNetworkAdapter.js'
import LFNetworkAdapter from '../src/network/LocalFirstRelayNetworkAdapter.js'

import Network from '../src/network/Network.js'
import StorageSystem from '../src/storage/StorageSubsystem.js'
import CollectionSynchronizer from '../src/network/CollectionSynchronizer.js'

const repo = new Repo()

const storageSubsystem = new StorageSystem(StorageAdapter())
repo.addEventListener('document', (ev) => storageSubsystem.onDocument(ev))
const networkSubsystem = new Network([new LFNetworkAdapter('ws://localhost:8080'), new BCNetworkAdapter()])
const synchronzier = new CollectionSynchronizer(networkSubsystem, repo)

const docName = window.location.hash.replace(/^#/, '') || 'my-todo-list'
let docId = await localforage.getItem(`docId:${docName}`)
let doc

if (!docId) {
  [docId, doc] = repo.create()
  localforage.setItem(`docId:${docName}`, docId)
} else {
  const automergeDoc = await storageSubsystem.load(docId)
  doc = repo.load(docId, automergeDoc)
}

// this is... okay. i don't like the whole ev.detail business but it's probably fine.
doc.addEventListener('change', (ev) => render(ev.detail))
render({ doc: doc.value() })
// by the time we add the event listener, the event for loading the doc has already passed

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
  doc.change((doc) => {
    if (!doc.items) doc.items = []
    doc.items.push({ text, done: false })
  })
}

function toggleItem(i) {
  doc.change((doc) => {
    doc.items[i].done = !doc.items[i].done
  })
}

const form = document.querySelector('form')
const input = document.querySelector('#new-todo')
form.onsubmit = (ev) => {
  ev.preventDefault()
  addItem(input.value)
  input.value = null
}

function render({ doc }) {
  if (!doc) { return }
  const list = document.querySelector('#todo-list')
  list.innerHTML = ''
  if (doc.items) {
    doc.items.forEach((item, index) => {
      const itemEl = document.createElement('li')
      itemEl.innerText = item.text
      itemEl.style = item.done ? 'text-decoration: line-through' : ''
      itemEl.onclick = () => toggleItem(index)
      list.appendChild(itemEl)
    })
  }
}
