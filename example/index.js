/* eslint-disable no-undef */
/* eslint-disable no-param-reassign */
/* eslint-disable no-use-before-define */
/* eslint-disable no-shadow */
import '../vendor/localforage.js'
import makeRepo from './makeRepo.js'

const repo = makeRepo()

async function getRootDocument() {
  let docId = window.location.hash.replace(/^#/, '')
  if (!docId) {
    docId = await localforage.getItem('root')
  }
  let rootHandle

  if (!docId) {
    rootHandle = repo.create()
    localforage.setItem('root', listHandle.documentId)
  } else {
    rootHandle = await repo.getOrLoadOrRequest(docId)
  }
  return rootHandle
}

const listHandle = await getRootDocument()
const list = document.querySelector('#todo-list')
listHandle.addEventListener('change', (ev) => {
  const { handle } = ev.detail
  renderList(list, handle)
})
renderList(list, listHandle)

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
  const itemDoc = repo.create()
  itemDoc.change((i) => {
    i.text = text
    i.done = false
  })
  listHandle.change((doc) => {
    if (!doc.items) doc.items = []
    doc.items.push(itemDoc.documentId)
  })
}

function toggleItem(h) {
  h.change((i) => {
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

// need handle listener management :/
async function renderItem(itemEl, itemHandle) {
  const item = await itemHandle.value()
  if (!item) { itemEl.innerText = '#MISSING'; return }
  itemEl.innerText = item.text
  itemEl.style = item.done ? 'text-decoration: line-through' : ''
  itemEl.onclick = () => toggleItem(itemHandle)
}

async function renderList(location, listHandle) {
  const doc = await listHandle.value()
  if (!doc) { return }
  location.innerHTML = ''
  if (doc.items) {
    doc.items.forEach(async (itemId) => {
      const itemEl = document.createElement('li')
      itemEl.innerText = `loading ${itemId}...`
      location.appendChild(itemEl)
      const itemHandle = await repo.getOrLoadOrRequest(itemId)
      renderItem(itemEl, itemHandle)
      itemHandle.addEventListener('change', (ev) => {
        const { handle } = ev.detail
        renderItem(itemEl, handle)
      })
    })
  }
}
