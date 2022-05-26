import '../vendor/localforage.js'
import BrowserRepo from '../src/BrowserRepo.js'

const repo = BrowserRepo()

async function getRootDocument() {
  let docId = window.location.hash.replace(/^#/, '')
  if (!docId) {
    docId = await localforage.getItem('root')
  }
  let rootHandle

  if (!docId) {
    rootHandle = repo.create()
    localforage.setItem('root', rootHandle.documentId)
  } else {
    rootHandle = await repo.find(docId)
  }
  return rootHandle
}

/* wire up the re-render logic (this is my 10c react clone) */
const rootHandle = await getRootDocument()
const list = document.querySelector('#todo-list')
rootHandle.on('change', ({ handle }) => {
  renderList(list, handle)
})
renderList(list, rootHandle)

/* adding an item happens on a sub-document */
function addItem(listHandle, text) {
  // don't actually do this, this is way overkill
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
  addItem(rootHandle, input.value)
  input.value = null
}

// need handle listener management, we're gonna leak like a sinking boat here
// but i'm going to leave it since this should be handled by react/vue/svelte instead
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
      const itemHandle = await repo.find(itemId)
      renderItem(itemEl, itemHandle)
      itemHandle.on('change', ({ handle }) => {
        renderItem(itemEl, handle)
      })
    })
  }
}
