
// Saving & loading

let docId = "my-todo-list" // arbitrary name
let binary = await localforage.getItem(docId)
if (binary) {
  doc = Automerge.load(binary)
  render(doc)
}

// TODO: remember to add save() to updateDoc()
function save(doc) {
    let binary = Automerge.save(doc)
    localforage.setItem(docId, binary).catch(err => console.log(err))
}
























// Synchronization between tabs
let channel = new BroadcastChannel(docId)
let lastSync = doc

function sync() {
    let changes = Automerge.getChanges(lastSync, doc)
    channel.postMessage(changes)
    lastSync = doc
}

channel.onmessage = (ev) => {
    let [newDoc, patch] = Automerge.applyChanges(doc, ev.data)
    doc = newDoc
    render(newDoc)
}

// we can do this automatically on updateDoc
// but let's use a button first to demonstrate
let button = document.createElement("button")
button.innerText = "Transmit changes"
button.onclick = () => sync()
document.body.appendChild(button)
