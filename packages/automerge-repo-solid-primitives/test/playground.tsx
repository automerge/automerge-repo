import * as automergeRepo from "@automerge/automerge-repo"
import { Repo, type PeerId, type AutomergeUrl } from "@automerge/automerge-repo"
import * as automerge from "@automerge/automerge"
import { render } from "@solidjs/web"
import * as solid from "solid-js"
import { createSignal, createEffect, For, Show, Loading } from "solid-js"
import * as solidPrimitives from "../src/index.js"
import {
  RepoContext,
  useRepo,
  useDocument,
  useDocHandle,
  createDocumentProjection,
  makeDocumentProjection,
} from "../src/index.js"

// ── types ──────────────────────────────────────────────────────────

interface TodoItem {
  title: string
  done: boolean
}

interface ExampleDoc {
  title: string
  count: number
  tags: string[]
  todos: TodoItem[]
}

// ── repo setup ─────────────────────────────────────────────────────

const repo = new Repo({ peerId: "playground" as PeerId })

const initial: ExampleDoc = {
  title: "My Document",
  count: 0,
  tags: ["automerge", "solid", "playground"],
  todos: [
    { title: "Try useDocument", done: false },
    { title: "Try makeDocumentProjection", done: false },
    { title: "Open devtools and poke around", done: false },
  ],
}

const handle = repo.create<ExampleDoc>(initial)

// ── expose to devtools ─────────────────────────────────────────────

Object.assign(window, {
  repo,
  handle,
  // libraries
  automerge,
  automergeRepo,
  solid,
  // primitives
  ...solidPrimitives,
  makeDocumentProjection,
})
console.log(
  "%cautomerge-repo-solid-primitives playground",
  "font-size: 1.2em; font-weight: bold"
)
console.log("Available on window:")
console.log("  repo    - the Repo instance")
console.log("  handle  - the DocHandle<ExampleDoc>")
console.log("  doc     - reactive document accessor (set after mount)")
console.log("  url     - the document URL signal [get, set]")
console.log("")
console.log("Try in devtools:")
console.log('  handle.change(d => d.title = "Hello from devtools!")')
console.log("  handle.change(d => d.count++)")
console.log('  handle.change(d => d.tags.push("new-tag"))')
console.log(
  '  handle.change(d => d.todos.push({title: "new todo", done: false}))'
)
console.log("  handle.change(d => d.todos[0].done = true)")
console.log("")
console.log(`  url: ${handle.url}`)

// ── components ─────────────────────────────────────────────────────

function TodoList(props: { todos: TodoItem[]; onToggle: (i: number) => void }) {
  return (
    <ul>
      <For each={props.todos}>
        {(todo, i) => (
          <li
            style={{
              "text-decoration": todo().done ? "line-through" : "none",
              cursor: "pointer",
              "user-select": "none",
            }}
            onClick={() => props.onToggle(i())}
          >
            {todo().done ? "[x]" : "[ ]"} {todo().title}
          </li>
        )}
      </For>
    </ul>
  )
}

function DocViewer() {
  const contextRepo = useRepo()
  const [docUrl, setDocUrl] = createSignal<AutomergeUrl | undefined>(handle.url)

  // useDocument - returns [doc accessor, handle resource]
  const [doc, docHandle] = useDocument<ExampleDoc>(docUrl)

  createEffect(
    () => doc()?.title,
    title => {
      console.log("Document changed:", title)
      console.log(title)
    }
  )

  createEffect(docHandle, handle => {
    console.log("Doc handle changed:", handle)
  })

  // useDocHandle - returns handle accessor directly
  const handleFromHook = useDocHandle<ExampleDoc>(docUrl)

  // createDocumentProjection - from a handle accessor
  const projectedDoc = createDocumentProjection<ExampleDoc>(handleFromHook)

  // ── actions ────────────────────────────────────────────────────
  function increment() {
    docHandle()?.change((d: ExampleDoc) => d.count++)
  }

  function decrement() {
    docHandle()?.change((d: ExampleDoc) => d.count--)
  }

  function addTag() {
    const tag = prompt("Tag name:")
    if (tag) docHandle()?.change((d: ExampleDoc) => d.tags.push(tag))
  }

  function removeTag(index: number) {
    docHandle()?.change((d: ExampleDoc) => d.tags.splice(index, 1))
  }

  function addTodo() {
    const title = prompt("Todo title:")
    if (title)
      docHandle()?.change((d: ExampleDoc) =>
        d.todos.push({ title, done: false })
      )
  }

  function toggleTodo(index: number) {
    docHandle()?.change(
      (d: ExampleDoc) => (d.todos[index].done = !d.todos[index].done)
    )
  }

  function setTitle() {
    const title = prompt("New title:", doc()?.title)
    if (title != null) docHandle()?.change((d: ExampleDoc) => (d.title = title))
  }

  function createNewDoc() {
    const newHandle = contextRepo.create<ExampleDoc>({
      title: "New Document",
      count: 0,
      tags: [],
      todos: [],
    })
    Object.assign(window, { handle: newHandle })
    setDocUrl(newHandle.url)
    console.log(`Switched to new doc: ${newHandle.url}`)
  }

  function clearDoc() {
    setDocUrl(undefined)
  }

  return (
    <div
      style={{
        "font-family": "system-ui, sans-serif",
        padding: "2rem",
        "max-width": "640px",
        margin: "0 auto",
      }}
    >
      <h1 style={{ "margin-bottom": "0.25rem" }}>
        automerge-repo-solid-primitives
      </h1>
      <p style={{ color: "#666", "margin-top": "0" }}>
        Open devtools console for interactive access
      </p>

      <div style={{ display: "flex", gap: "0.5rem", "margin-bottom": "1rem" }}>
        <button onClick={createNewDoc}>New Doc</button>
        <button onClick={clearDoc}>Clear URL</button>
      </div>

      {/* Title */}
      <section>
        <h2
          onClick={setTitle}
          style={{ cursor: "pointer" }}
          title="Click to edit"
        >
          <Loading fallback={<span>Loading...</span>}>{doc()?.title}</Loading>
        </h2>
        <code style={{ "font-size": "0.75rem", color: "#888" }}>
          {docUrl()}
        </code>
      </section>

      <Loading>
        {/* Counter */}
        <section style={{ margin: "1rem 0" }}>
          <h3>Count: {doc()?.count}</h3>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button onClick={decrement}>-</button>
            <button onClick={increment}>+</button>
          </div>
        </section>

        {/* Tags */}
        <section style={{ margin: "1rem 0" }}>
          <h3>Tags</h3>
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              "flex-wrap": "wrap",
            }}
          >
            <For each={doc()?.tags}>
              {(tag, i) => (
                <span
                  style={{
                    background: "#e0e7ff",
                    padding: "0.2rem 0.6rem",
                    "border-radius": "1rem",
                    "font-size": "0.85rem",
                    cursor: "pointer",
                  }}
                  onClick={() => removeTag(i())}
                  title="Click to remove"
                >
                  {tag()} x
                </span>
              )}
            </For>
            <button onClick={addTag} style={{ "font-size": "0.85rem" }}>
              + Add
            </button>
          </div>
        </section>

        {/* Todos */}
        <section style={{ margin: "1rem 0" }}>
          <h3>Todos</h3>
          <TodoList todos={doc()?.todos ?? []} onToggle={toggleTodo} />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button onClick={addTodo}>+ Add Todo</button>
          </div>
        </section>

        {/* Projection comparison */}
        <section
          style={{
            margin: "1rem 0",
            padding: "1rem",
            background: "#f8f8f8",
            "border-radius": "0.5rem",
          }}
        >
          <h3 style={{ "margin-top": "0" }}>createDocumentProjection</h3>
          <p style={{ "font-size": "0.85rem", color: "#666" }}>
            Second projection from the same handle via{" "}
            <code>createDocumentProjection</code>. Both views update from the
            same underlying CRDT.
          </p>
          <Show when={projectedDoc()}>
            {pd => (
              <pre style={{ "font-size": "0.8rem", overflow: "auto" }}>
                {JSON.stringify(pd(), null, 2)}
              </pre>
            )}
          </Show>
        </section>

        {/* Raw JSON */}
        <details>
          <summary style={{ cursor: "pointer", color: "#666" }}>
            Raw JSON (useDocument)
          </summary>
          <pre style={{ "font-size": "0.8rem", overflow: "auto" }}>
            {JSON.stringify(doc(), null, 2)}
          </pre>
        </details>
      </Loading>
    </div>
  )
}

// ── mount ──────────────────────────────────────────────────────────

render(
  () => (
    <RepoContext value={repo}>
      <DocViewer />
    </RepoContext>
  ),
  document.getElementById("app")!
)
