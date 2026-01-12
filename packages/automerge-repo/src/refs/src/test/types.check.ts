/**
 * Type checking file for Ref type inference.
 * Hover over variables to verify correct type inference.
 * This file is not executed - it's purely for type checking.
 */

import type { DocHandle } from "@automerge/automerge-repo";
import { ref } from "../factory";
import type { MutableText } from "../types";

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
const titleRef = ref(handle, "title");
titleRef.change((text) => {
  // text should be MutableText
  text.splice(0, 5, "Hello");
  text.updateText("New");
  text.toUpperCase(); // Should have all string methods
  const _t1: typeof text = {} as MutableText; // Should pass
});

// Number refs should receive number
const countRef = ref(handle, "count");
countRef.change((count) => {
  // count should be number
  const _n: typeof count = 0; // Should pass
  return count + 1;
});

// Object refs should receive the object
const userRef = ref(handle, "user");
userRef.change((user) => {
  // user should be { name: string; email: string }
  user.name = "Alice";
  user.email = "alice@example.com";
  const _u: typeof user = { name: "", email: "" }; // Should pass
});

// Nested string refs should receive MutableText
const nameRef = ref(handle, "user", "name");
nameRef.change((name) => {
  // name should be MutableText
  name.splice(0, 0, "Dr. ");
  const _n: typeof name = {} as MutableText; // Should pass
});

// Array element refs
const todoRef = ref(handle, "todos", 0);
todoRef.change((todo) => {
  // todo should be { title: string; done: boolean }
  todo.done = true;
  const _t: typeof todo = { title: "", done: false }; // Should pass
});

// Array element string field refs should receive MutableText
const todoTitleRef = ref(handle, "todos", 0, "title");
todoTitleRef.change((title) => {
  // title should be MutableText
  title.toUpperCase();
  const _t: typeof title = {} as MutableText; // Should pass
});

// value() return types
const titleValue = titleRef.value();
// titleValue should be string | undefined
const _tv: typeof titleValue = "" as string | undefined;

const countValue = countRef.value();
// countValue should be number | undefined
const _cv: typeof countValue = 0 as number | undefined;

const userValue = userRef.value();
// userValue should be { name: string; email: string } | undefined
const _uv: typeof userValue = { name: "", email: "" } as
  | { name: string; email: string }
  | undefined;

// Root document ref
const rootRef = ref(handle);
rootRef.change((doc) => {
  // doc should be TestDoc
  doc.title = "New Title";
  doc.count = 42;
  const _d: typeof doc = {} as TestDoc; // Should pass
});

// Runtime warning: returning objects/arrays (no type error, just warning)
const objectRef = ref(handle, "user");

// ✅ Correct: mutate in place
objectRef.change((user) => {
  user.name = "Alice";
});

// ⚠️ This compiles but triggers a runtime warning
objectRef.change((user) => {
  return { name: "Bob", email: "bob@example.com" }; // Warning logged
});

const todosRef = ref(handle, "todos");

// ✅ Correct: mutate in place
todosRef.change((todos) => {
  todos[0].done = true;
});

// ⚠️ This compiles but triggers a runtime warning
todosRef.change((todos) => {
  return [{ title: "New", done: false }]; // Warning logged
});

// ✅ Can return primitives
const countRef2 = ref(handle, "count");
countRef2.change((count) => {
  return count + 1; // ✅ Works fine
});

const titleRef2 = ref(handle, "title");
titleRef2.change((title) => {
  return title.toUpperCase(); // ✅ Works fine (MutableText is treated as primitive-like)
});

// === Type Inference Tests ===
// Test where type inference should work vs fail

// ✅ SHOULD WORK: Direct string key access
const directKeyRef = ref(handle, "user", "name");
const directKeyValue = directKeyRef.value();
// Hover over directKeyValue - should be: string | undefined

// ✅ SHOULD WORK: Numeric index on array
const numericIndexRef = ref(handle, "todos", 0, "title");
const numericIndexValue = numericIndexRef.value();
// Hover over numericIndexValue - should be: string | undefined

// ❓ TEST: ID pattern lookup - does this infer correctly?
const idPatternRef = ref(handle, "todos", { done: true }, "title");
const idPatternValue = idPatternRef.value();
// Hover over idPatternValue - is this string | undefined or unknown?

// ❓ TEST: Nested ID pattern - does this infer correctly?
type NestedDoc = {
  users: Array<{
    id: string;
    profile: {
      name: string;
    };
  }>;
};
declare const nestedHandle: DocHandle<NestedDoc>;

const nestedIdPatternRef = ref(
  nestedHandle,
  "users",
  { id: "123" },
  "profile",
  "name"
);
const nestedIdPatternValue = nestedIdPatternRef.value();
// Hover over nestedIdPatternValue - is this string | undefined or unknown?

// ✅ TEST: Deep nesting with literal keys (should work)
type DeepDoc = {
  a: { b: { c: { d: { e: string } } } };
};
declare const deepHandle: DocHandle<DeepDoc>;

const deepRef = ref(deepHandle, "a", "b", "c", "d", "e");
const deepValue = deepRef.value();
// Hover over deepValue - should be: string | undefined

// === String Path Type Inference Tests ===
import { fromString } from "../utils";
import type { SegmentsFromString, InferRefTypeFromString } from "../types";

// Test PathFromString parsing
type TestSplit1 = SegmentsFromString<"todos/0/title">;
// Should be: ["todos", number, "title"]

type TestSplit2 = SegmentsFromString<"text/[cursor1-cursor2]">;
// Should be: ["text", CursorRangeMarker] (where CursorRangeMarker is the internal marker)

type TestSplit3 = SegmentsFromString<"users">;
// Should be: ["users"]

// Test InferRefTypeFromString
type DocForStringTest = {
  title: string;
  count: number;
  todos: Array<{ title: string; done: boolean }>;
  content: string;
};

type Test1 = InferRefTypeFromString<DocForStringTest, "title">;
// Should be: string

type Test2 = InferRefTypeFromString<DocForStringTest, "todos/0/title">;
// Should be: string

type Test3 = InferRefTypeFromString<DocForStringTest, "count">;
// Should be: number

// Test fromString function with type inference
declare const stringTestHandle: DocHandle<DocForStringTest>;

const stringTitleRef = fromString(stringTestHandle, "title");
const stringTitleValue = stringTitleRef.value();
// Hover over stringTitleValue - should be: string | undefined

const stringTodoTitleRef = fromString(stringTestHandle, "todos/0/title");
const stringTodoTitleValue = stringTodoTitleRef.value();
// Hover over stringTodoTitleValue - should be: string | undefined

const stringCountRef = fromString(stringTestHandle, "count");
const stringCountValue = stringCountRef.value();
// Hover over stringCountValue - should be: number | undefined
