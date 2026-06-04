/**
 * Type checking file for Ref type inference.
 * Hover over variables to verify correct type inference.
 * This file is not executed - it's purely for type checking.
 */

import type { DocHandle } from "../../src/DocHandle.js";
import type { MutableText } from "../../src/subdoc-handles/types.js";

type TestDoc = {
  title: string;
  count: number;
  todos: Array<{ title: string; done: boolean }>;
  user: {
    name: string;
    email: string;
  };
};

declare const handle: DocHandle<TestDoc>;

// String refs should receive MutableText
const titleRef = handle.sub("title");
titleRef.change((text) => {
  // text should be MutableText
  text.splice(0, 5, "Hello");
  text.updateText("New");
  text.toUpperCase(); // Should have all string methods
  const _t1: typeof text = {} as MutableText; // Should pass
});

// Number refs should receive number
const countRef = handle.sub("count");
countRef.change((count) => {
  // count should be number
  const _n: typeof count = 0; // Should pass
  return count + 1;
});

// Object refs should receive the object
const userRef = handle.sub("user");
userRef.change((user) => {
  // user should be { name: string; email: string }
  user.name = "Alice";
  user.email = "alice@example.com";
  const _u: typeof user = { name: "", email: "" }; // Should pass
});

// Nested string refs should receive MutableText
const nameRef = handle.sub("user", "name");
nameRef.change((name) => {
  // name should be MutableText
  name.splice(0, 0, "Dr. ");
  const _n: typeof name = {} as MutableText; // Should pass
});

// Array element refs
const todoRef = handle.sub("todos", 0);
todoRef.change((todo) => {
  // todo should be { title: string; done: boolean }
  todo.done = true;
  const _t: typeof todo = { title: "", done: false }; // Should pass
});

// Array element string field refs should receive MutableText
const todoTitleRef = handle.sub("todos", 0, "title");
todoTitleRef.change((title) => {
  // title should be MutableText
  title.toUpperCase();
  const _t: typeof title = {} as MutableText; // Should pass
});

// doc() return types
//
// Required-key paths are now `undefined`-free: the spurious `| undefined`
// only appears for array-index / pattern hops (see below).
const titleValue = titleRef.doc();
// titleValue should be string (NOT string | undefined)
const _tv: typeof titleValue = "" as string;

const countValue = countRef.doc();
// countValue should be number
const _cv: typeof countValue = 0 as number;

const userValue = userRef.doc();
// userValue should be { name: string; email: string }
const _uv: typeof userValue = { name: "", email: "" } as {
  name: string;
  email: string;
};

// Array-index hops DO carry `| undefined` (noUncheckedIndexedAccess semantics).
const todoValue = todoRef.doc();
const _todov: typeof todoValue = { title: "", done: false } as
  | { title: string; done: boolean }
  | undefined;
// undefined must be assignable here
const _todovUndef: typeof todoValue = undefined;

// A required key *after* an index hop stays `| undefined`.
const todoTitleValue = todoTitleRef.doc();
const _ttv: typeof todoTitleValue = "" as string | undefined;
const _ttvUndef: typeof todoTitleValue = undefined;

// Root document ref
const rootRef = handle.sub();
rootRef.change((doc) => {
  // doc should be TestDoc
  doc.title = "New Title";
  doc.count = 42;
  const _d: typeof doc = {} as TestDoc; // Should pass
});

// Runtime warning: returning objects/arrays (no type error, just warning)
const objectRef = handle.sub("user");

// ✅ Correct: mutate in place
objectRef.change((user) => {
  user.name = "Alice";
});

// ⚠️ This compiles but triggers a runtime warning
objectRef.change((user) => {
  return { name: "Bob", email: "bob@example.com" }; // Warning logged
});

const todosRef = handle.sub("todos");

// ✅ Correct: mutate in place
todosRef.change((todos) => {
  todos[0].done = true;
});

// ⚠️ This compiles but triggers a runtime warning
todosRef.change((todos) => {
  return [{ title: "New", done: false }]; // Warning logged
});

// ✅ Can return primitives
const countRef2 = handle.sub("count");
countRef2.change((count) => {
  return count + 1; // ✅ Works fine
});

const titleRef2 = handle.sub("title");
titleRef2.change((title) => {
  return title.toUpperCase(); // ✅ Works fine (MutableText is treated as primitive-like)
});

// === Type Inference Tests ===
//
// These assert on `InferSubType` directly (the type that drives `.sub()`
// and `.doc()`), which avoids the `A.Doc<...>` readonly wrapper that
// `doc()` applies and lets us check the value type *exactly*.
import type { InferSubType } from "../../src/subdoc-handles/types.js";

// Compile-time exact-equality assertion (no runtime component).
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y
  ? 1
  : 2
  ? true
  : false;
type Expect<T extends true> = T;

// ✅ Direct string key access (required key → no undefined)
type _DirectKey = Expect<
  Equal<InferSubType<TestDoc, ["user", "name"]>, string>
>;

// ✅ Numeric index on array → `| undefined` (noUncheckedIndexedAccess)
type _NumericIndex = Expect<
  Equal<InferSubType<TestDoc, ["todos", 0, "title"]>, string | undefined>
>;

// ✅ The array element itself is `| undefined`
type _IndexElement = Expect<
  Equal<
    InferSubType<TestDoc, ["todos", 0]>,
    { title: string; done: boolean } | undefined
  >
>;

// ✅ Pattern lookup behaves like an index hop → `| undefined`
type _IdPattern = Expect<
  Equal<
    InferSubType<TestDoc, ["todos", { done: true }, "title"]>,
    string | undefined
  >
>;

// ✅ Nested ID pattern resolves through and stays `| undefined`
type NestedDoc = {
  users: Array<{
    id: string;
    profile: {
      name: string;
    };
  }>;
};
type _NestedIdPattern = Expect<
  Equal<
    InferSubType<NestedDoc, ["users", { id: "123" }, "profile", "name"]>,
    string | undefined
  >
>;

// ✅ Deep nesting with literal keys (all required) → no undefined
type DeepDoc = {
  a: { b: { c: { d: { e: number } } } };
};
type _DeepNumber = Expect<
  Equal<InferSubType<DeepDoc, ["a", "b", "c", "d", "e"]>, number>
>;

// ✅ Optional key carries `| undefined` even without an index hop
type OptionalDoc = { meta?: { tag: string } };
type _Optional = Expect<
  Equal<InferSubType<OptionalDoc, ["meta"]>, { tag: string } | undefined>
>;
// ...and a required key reached *through* an optional one stays nullable
type _OptionalTag = Expect<
  Equal<InferSubType<OptionalDoc, ["meta", "tag"]>, string | undefined>
>;

// ✅ Chaining `.sub()` off an index handle propagates nullability:
// the base type is already `{...} | undefined`, so the next hop stays nullable.
type _Chained = Expect<
  Equal<
    InferSubType<InferSubType<TestDoc, ["todos", 0]>, ["title"]>,
    string | undefined
  >
>;

// ✅ Root / empty path is the document itself (undefined-free)
type _Root = Expect<Equal<InferSubType<TestDoc, []>, TestDoc>>;

// doc()-level integration: the root document value is usable without narrowing
// (under strictNullChecks this also proves it is never `| undefined`).
const rootValue = handle.sub().doc();
rootValue.title;

// === String Path Type Inference Tests ===
import type {
  SegmentsFromString,
  InferSubTypeFromString,
} from "../../src/subdoc-handles/types.js";

// Test PathFromString parsing
type TestSplit1 = SegmentsFromString<"todos/0/title">;
// Should be: ["todos", number, "title"]

type TestSplit2 = SegmentsFromString<"text/[cursor1-cursor2]">;
// Should be: ["text", CursorRangeMarker] (where CursorRangeMarker is the internal marker)

type TestSplit3 = SegmentsFromString<"users">;
// Should be: ["users"]

// Test InferSubTypeFromString
type DocForStringTest = {
  title: string;
  count: number;
  todos: Array<{ title: string; done: boolean }>;
  content: string;
};

type Test1 = InferSubTypeFromString<DocForStringTest, "title">;
type _Test1 = Expect<Equal<Test1, string>>;

// `@0` is an index hop → `| undefined`
type Test2 = InferSubTypeFromString<DocForStringTest, "todos/@0/title">;
type _Test2 = Expect<Equal<Test2, string | undefined>>;

type Test3 = InferSubTypeFromString<DocForStringTest, "count">;
type _Test3 = Expect<Equal<Test3, number>>;

// Note: in the pre-unification API there was a `refFromString(handle, "a/b/c")`
// helper. Now `handle.sub(...)` takes variadic path inputs directly, so the
// string-path types above are still useful for URL parsing but there is no
// dedicated helper here.

function doubleIt(ref: DocHandle<number>) {
  ref.change((n) => n * 2);
}

// A deep all-required-keys path infers `DocHandle<number>` (no `| undefined`),
// so it is assignable where a plain `DocHandle<number>` is expected.
declare const deepHandle: DocHandle<DeepDoc>;
const deepNumberRef = deepHandle.sub("a", "b", "c", "d", "e");
doubleIt(deepNumberRef); // Should pass
