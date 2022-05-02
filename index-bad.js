let doc = Automerge.init()

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
    save(newDoc)
    sync(newDoc)
}

function render(doc) {
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

const localStorageInterface = { 
  load: (docId) => localforage.getItem(docId),
  save: (docId, binary) => localforage.setItem(docId, binary).catch(err => console.log(err))
}

let repo = {
  create: async(storage, docId) => {
    return Automerge.init()
  },
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

const localfirstRelayNetwork = {
    fetch() {
        
    },
    sync() {

    }
}

// create, load, fetch
// save, sync

// to fetch a new doc from the server you make an empty one and then sync it which feels wrong

let docId = "my-todo-list" // arbitrary name
doc = await repo.load(storageInterface, docId)
render(doc)

repo.save(storageInterface, docId, doc)
// herb says maybe you shouldn't have to call save?
// or that you shouldn't have to think about the storageInterface



// Synchronization between tabs
/*
let lastSync = doc

function sync() {
    let changes = Automerge.getChanges(lastSync, doc)
    
    lastSync = doc
}

    let [newDoc, patch] = Automerge.applyChanges(doc, ev.data)
    doc = newDoc
    render(newDoc)
}
*/

// TODO: gotta handle disconnections
const network = {
  peers: {}
}

