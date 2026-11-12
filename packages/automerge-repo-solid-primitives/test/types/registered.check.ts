// Compile-time checks with a Repo type registered. Its own program, since a
// registration applies to a whole program.
// Not a test: checked by `pnpm lint`.
import type { HandleOf, Repo } from "@automerge/automerge-repo"
import { useDocHandle, useDocument, useRepo } from "../../src/index.js"
import { repo, type Todo } from "./extension.js"

declare module "../../src/index.js" {
  interface Register {
    repo: typeof repo
  }
}
declare const url: any

useDocHandle<Todo>(url)()?.ping().title
useDocument<Todo>(url)[1]()?.ping()
useRepo().handles
// An explicit handle type overrides the registration.
// @ts-expect-error
useDocHandle<HandleOf<Repo, Todo>>(url)()?.ping()
