/**
 * Type checking file for Ref type inference.
 * Hover over variables to verify correct type inference.
 * This file is not executed - it's purely for type checking.
 */

import type { DocHandle } from "../../src/DocHandle.js"
import type { MutableText } from "../../src/refs/types.js"

type TestDoc = {
  title: string
  count: number
  todos: Array<{ title: string; done: boolean }>
  user: {
    name: string
    email: string
  }
}

declare const handle: DocHandle<TestDoc>

// String refs should receive MutableText
const titleRef = handle.ref("title")
titleRef.change(text => {
  // text should be MutableText
  text.splice(0, 5, "Hello")
  text.updateText("New")
  text.toUpperCase() // Should have all string methods
  const _t1: typeof text = {} as MutableText // Should pass
})

// Number refs should receive number
const countRef = handle.ref("count")
countRef.change(count => {
  // count should be number
  const _n: typeof count = 0 // Should pass
  return count + 1
})

// Object refs should receive the object
const userRef = handle.ref("user")
userRef.change(user => {
  // user should be { name: string; email: string }
  user.name = "Alice"
  user.email = "alice@example.com"
  const _u: typeof user = { name: "", email: "" } // Should pass
})

// Nested string refs should receive MutableText
const nameRef = handle.ref("user", "name")
nameRef.change(name => {
  // name should be MutableText
  name.splice(0, 0, "Dr. ")
  const _n: typeof name = {} as MutableText // Should pass
})

// Array element refs
const todoRef = handle.ref("todos", 0)
todoRef.change(todo => {
  // todo should be { title: string; done: boolean }
  todo.done = true
  const _t: typeof todo = { title: "", done: false } // Should pass
})

// Array element string field refs should receive MutableText
const todoTitleRef = handle.ref("todos", 0, "title")
todoTitleRef.change(title => {
  // title should be MutableText
  title.toUpperCase()
  const _t: typeof title = {} as MutableText // Should pass
})

// value() return types
const titleValue = titleRef.value()
// titleValue should be string | undefined
const _tv: typeof titleValue = "" as string | undefined

const countValue = countRef.value()
// countValue should be number | undefined
const _cv: typeof countValue = 0 as number | undefined

const userValue = userRef.value()
// userValue should be { name: string; email: string } | undefined
const _uv: typeof userValue = { name: "", email: "" } as
  | { name: string; email: string }
  | undefined

// Root document ref
const rootRef = handle.ref()
rootRef.change(doc => {
  // doc should be TestDoc
  doc.title = "New Title"
  doc.count = 42
  const _d: typeof doc = {} as TestDoc // Should pass
})

// Runtime warning: returning objects/arrays (no type error, just warning)
const objectRef = handle.ref("user")

// ✅ Correct: mutate in place
objectRef.change(user => {
  user.name = "Alice"
})

// ⚠️ This compiles but triggers a runtime warning
objectRef.change(user => {
  return { name: "Bob", email: "bob@example.com" } // Warning logged
})

const todosRef = handle.ref("todos")

// ✅ Correct: mutate in place
todosRef.change(todos => {
  todos[0].done = true
})

// ⚠️ This compiles but triggers a runtime warning
todosRef.change(todos => {
  return [{ title: "New", done: false }] // Warning logged
})

// ✅ Can return primitives
const countRef2 = handle.ref("count")
countRef2.change(count => {
  return count + 1 // ✅ Works fine
})

const titleRef2 = handle.ref("title")
titleRef2.change(title => {
  return title.toUpperCase() // ✅ Works fine (MutableText is treated as primitive-like)
})

// === Type Inference Tests ===
// Test where type inference should work vs fail

// ✅ SHOULD WORK: Direct string key access
const directKeyRef = handle.ref("user", "name")
const directKeyValue = directKeyRef.value()
// Hover over directKeyValue - should be: string | undefined

// ✅ SHOULD WORK: Numeric index on array
const numericIndexRef = handle.ref("todos", 0, "title")
const numericIndexValue = numericIndexRef.value()
// Hover over numericIndexValue - should be: string | undefined

// ❓ TEST: ID pattern lookup - does this infer correctly?
const idPatternRef = handle.ref("todos", { done: true }, "title")
const idPatternValue = idPatternRef.value()
// Hover over idPatternValue - is this string | undefined or unknown?

// ❓ TEST: Nested ID pattern - does this infer correctly?
type NestedDoc = {
  users: Array<{
    id: string
    profile: {
      name: string
    }
  }>
}
declare const nestedHandle: DocHandle<NestedDoc>

const nestedIdPatternRef = nestedHandle.ref(
  "users",
  { id: "123" },
  "profile",
  "name"
)
const nestedIdPatternValue = nestedIdPatternRef.value()
// Hover over nestedIdPatternValue - is this string | undefined or unknown?

// ✅ TEST: Deep nesting with literal keys (should work)
type DeepDoc = {
  a: { b: { c: { d: { e: number } } } }
}
declare const deepHandle: DocHandle<DeepDoc>

const deepNumberRef = deepHandle.ref("a", "b", "c", "d", "e")
const deepNumberValue = deepNumberRef.value()
// Hover over deepNumberValue - should be: number | undefined

function doubleIt(ref: DocHandle<number>) {
  ref.change(n => n * 2)
}

doubleIt(deepNumberRef) // Should pass

// === Post-unification inference checks ===========================================
// Verify that sub-document handles are just `DocHandle<T>` and that the URL /
// repo.find / view surface remains inference-friendly.

import type { AutomergeUrl, UrlHeads } from "../../src/types.js"
import type { Repo } from "../../src/Repo.js"

// `handle.url` on any handle (root or sub) is an `AutomergeUrl`, with no separate
// "ref URL" type in the public API.
const _subUrl: AutomergeUrl = deepNumberRef.url

// `view` preserves the generic parameter on sub-handles too.
const _pinned: DocHandle<number> = deepNumberRef.view([] as unknown as UrlHeads)

// `repo.find(anyUrl)` returns `Promise<DocHandle<T>>` for both root and
// sub-document URLs — there's a single overload because both are `AutomergeUrl`.
declare const repo: Repo
async function _findChecks() {
  const viaRoot = await repo.find<TestDoc>(handle.url)
  viaRoot.change(d => {
    d.count = 1
  })

  // A sub-document URL resolves via the same `find`; callers pick the expected
  // element type explicitly.
  const viaRef = await repo.find<string>(titleRef.url)
  const _sv: string | undefined = viaRef.value()
}
