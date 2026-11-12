import type { Repo } from "@automerge/automerge-repo/slim"
import { RepoContext } from "./context.js"
import { useContext } from "solid-js"

/**
 * Register your Repo's type, once per app, so that these primitives are
 * typed with the features its backend adds to handles:
 *
 * ```ts
 * declare module "@automerge/automerge-repo-solid-primitives" {
 *   interface Register {
 *     repo: typeof repo
 *   }
 * }
 * ```
 *
 * Registering asserts what the Repo in {@link RepoContext} is; nothing
 * checks it. See also {@link createRepoPrimitives}, which is checked.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}

/** The {@link Register registered} Repo type; a plain `Repo` by default. */
export type RegisteredRepo = Register extends { repo: infer R extends Repo }
  ? R
  : Repo

/** grab the repo from the {@link RepoContext}, typed as `R` (the
 * {@link Register registered} Repo type by default; not checked) */
export default function useRepo<R extends Repo = RegisteredRepo>(): R {
  const repo = useContext(RepoContext)
  if (!repo) throw new Error("Please wrap me in a <RepoContext value={repo}>")
  return repo as R
}
