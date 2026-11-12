import { Repo } from "@automerge/automerge-repo/slim"
import { createContext, useContext } from "react"

/** A [React context](https://react.dev/learn/passing-data-deeply-with-context) which provides access to an Automerge repo. */
export const RepoContext = createContext<Repo | null>(null)

/**
 * Register your Repo's type, once per app, so that these hooks are typed with
 * the features its backend adds to handles:
 *
 * ```ts
 * declare module "@automerge/react" {
 *   interface Register {
 *     repo: typeof repo
 *   }
 * }
 * ```
 *
 * Registering asserts what the Repo in {@link RepoContext} is; nothing
 * checks it. See also {@link createRepoHooks}, which is checked.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}

/** The {@link Register registered} Repo type; a plain `Repo` by default. */
export type RegisteredRepo = Register extends { repo: infer R extends Repo }
  ? R
  : Repo

/**
 * A [React hook](https://reactjs.org/docs/hooks-intro.html) which returns the
 * Automerge repo from {@link RepoContext}, typed as `R` (the
 * {@link Register registered} Repo type by default; not checked).
 */
export function useRepo<R extends Repo = RegisteredRepo>(): R {
  const repo = useContext(RepoContext)
  if (!repo) throw new Error("Repo was not found on RepoContext.")
  return repo as R
}
