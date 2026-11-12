// Compile-time checks with a Repo type registered, against the built
// package. Its own program, since a registration applies to a whole program.
// Not a test: checked by `pnpm lint`.
import type { HandleOf, Repo } from "@automerge/automerge-repo"
import { document, getContextRepo } from "../../dist/index.js"
import { repo, type Todo } from "./extension.js"

declare module "../../dist/index.js" {
  interface Register {
    repo: typeof repo
  }
}
declare const url: any

async function checks() {
  ;(await document<Todo>(url))?.handle.ping().title
  getContextRepo().handles
  // An explicit handle type overrides the registration.
  // @ts-expect-error
  ;(await document<HandleOf<Repo, Todo>>(url))?.handle.ping()
}
void checks
