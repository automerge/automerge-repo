/* eslint-disable no-param-reassign */
/* eslint-disable import/extensions */
/* eslint-disable no-use-before-define */
/* eslint-disable no-shadow */
import Repo from '../src/Repo.js'
import StorageAdapter from '../src/storage/LocalForageStorageAdapter.js'
import NetworkAdapter from '../src/network/BroadcastChannelNetworkAdapter.js'

const repo = new Repo(StorageAdapter(), new NetworkAdapter('ws://localhost:8080'))

// this is an antipattern!
// the client shouldn't invent the docId, because that's how we wind up with collisions
let docId = window.location.hash.replace(/^#/, '') || 'my-todo-list'
let doc = await repo.load(docId)
if (!doc) { doc = repo.create(docId) }
// this is... okay. i don't like the whole ev.detail business but it's probably fine.
doc.addEventListener('change', (ev) => render(ev.detail))
render({ doc: doc.value() }) // by the time we add the event listener, the event for loading the doc has already passed

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

function render({doc}) {
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
