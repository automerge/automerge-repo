import { newRepo, storageInterface, networkInterface } from './repo.js' 
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
    doc = repo.change(docId, doc => {
      if (!doc.items) doc.items = []
      doc.items.push({ text, done: false })
    })
    render(doc)
}

function toggleItem(i) {
    doc = repo.change(docId, doc => {
        doc.items[i].done = !doc.items[i].done
    })
    render(doc)
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

const url = "ws://localhost:8080"
const repo = newRepo(storageInterface, networkInterface, url)

let docId = "my-todo-list" // arbitrary name
let doc = await repo.load(docId)
if (!doc) { doc = Automerge.init() }
render(doc)
