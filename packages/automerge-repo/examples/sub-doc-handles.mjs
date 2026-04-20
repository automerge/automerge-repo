// A small, runnable tour of the unified DocHandle / Ref API.
//
// Every "ref" is just a DocHandle scoped to a path inside a document, so the same
// methods you know from a root handle (doc / value / change / history / on / url /
// viewAt / ...) also work on a sub-document.
//
// Run with plain node (after `pnpm build` in this package):
//
//   node examples/sub-doc-handles.mjs

import { next as Automerge } from "@automerge/automerge"
import { Repo } from "../dist/index.js"

async function main() {
  const repo = new Repo()

  // 1. Create a regular root document ---------------------------------------
  const handle = repo.create()
  handle.change(d => {
    d.title = "Groceries"
    d.todos = [
      { id: "a", title: "Milk", done: false },
      { id: "b", title: "Eggs", done: false },
      { id: "c", title: "Bread", done: true },
    ]
  })

  console.log("root url:", handle.url)

  // 2. Carve out a sub-document handle --------------------------------------
  // handle.ref(...) / handle.sub(...) return a DocHandle scoped to a path.
  const firstTodo = handle.ref("todos", 0)

  console.log("sub  url:", firstTodo.url)
  console.log("sub  value():", firstTodo.value())
  // => { id: "a", title: "Milk", done: false }

  // You can also match by pattern instead of by index — useful when you care
  // about identity rather than position.
  const byId = handle.ref("todos", { id: "a" })
  console.log("byId url:  ", byId.url)
  console.log("byId value:", byId.value())

  // 3. Listen for changes scoped to the sub-path ----------------------------
  firstTodo.on("change", ({ patches }) => {
    console.log(
      `firstTodo changed; ${patches.length} patch(es):`,
      firstTodo.value()
    )
  })

  // A change to a *different* todo won't fire the listener above.
  handle.change(d => {
    d.todos[2].done = false
  })

  // Mutate directly through the sub-handle — semantics match Automerge's
  // in-place change callback.
  firstTodo.change(todo => {
    todo.done = true
  })

  // Mutating a string sub-handle gives you a MutableText proxy with splice().
  const titleRef = firstTodo.ref("title")
  titleRef.change(text => {
    text.splice(0, 4, "Oat milk")
  })
  console.log("title after splice:", titleRef.value())

  // 4. Filtered history -----------------------------------------------------
  // handle.history() returns every change. A sub-handle's history() only
  // includes heads where the sub-path was actually touched.
  console.log("root history length:     ", handle.history().length)
  console.log("firstTodo history length:", firstTodo.history().length)

  // 5. Time travel ----------------------------------------------------------
  // viewAt(heads) returns a read-only sub-handle at a past point in time.
  // It accepts either UrlHeads (from handle.heads()) or raw Automerge heads
  // (from Automerge.getHeads(doc)).
  // firstTodo.history()[0] is the heads right after firstTodo was created.
  const afterCreate = firstTodo.history()[0]
  const earlyFirstTodo = firstTodo.viewAt(afterCreate)
  console.log("firstTodo at creation:", earlyFirstTodo.value())

  // 6. repo.find(refUrl) ----------------------------------------------------
  // The URL of a sub-handle is a real identifier you can hand out and resolve
  // later — even across repos, in real code.
  const url = firstTodo.url
  const rediscovered = await repo.find(url)
  console.log("rediscovered via URL:", rediscovered.value())
  console.log(
    "same documentId?     ",
    rediscovered.documentId === firstTodo.documentId
  )

  // A ref URL with #heads resolves to a read-only, pinned sub-handle.
  const heads = Automerge.getHeads(handle.doc())
  const pinnedUrl = firstTodo.viewAt(heads).url
  const pinned = await repo.find(pinnedUrl)
  console.log("pinned isReadOnly?   ", pinned.isReadOnly())
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
