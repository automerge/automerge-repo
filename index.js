/* eslint-disable no-param-reassign */
/* eslint-disable import/extensions */
/* eslint-disable no-use-before-define */
/* eslint-disable no-shadow */
import Repo from './repo.js'
import StorageInterface from './localforageInterface.js'
import NetworkInterface from './localfirstrelaynetwork.js'

// TODO: this interface is wrong. the URL shouldn't be passed into the Repo
const url = 'ws://localhost:8080'
const repo = new Repo(StorageInterface(), new NetworkInterface(url))

let docId = window.location.hash.replace(/^#/, '') || 'my-todo-list'

// this is an antipattern!
// the client shouldn't invent the docId, because that's how we wind up with collisions
let doc = await repo.load(docId)
if (!doc) { doc = repo.create(docId) }
// this is... okay. i don't like the whole ev.detail business but it's probably fine.
doc.addEventListener('change', (ev) => render(ev.detail.doc))
render(doc.value()) // by the time we add the event listener, the event for loading the doc has already passed

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

function render(doc) {
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
