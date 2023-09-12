import { Repo } from "@automerge/automerge-repo"
import { createContext, useContext } from "react"

/** A [React context](https://react.dev/learn/passing-data-deeply-with-context) which provides access to an Automerge repo. */
export const RepoContext = createContext<Repo | null>(null)

/** A [React hook](https://reactjs.org/docs/hooks-intro.html) which returns the Automerge repo from {@link RepoContext}. */
export function useRepo(): Repo {
  const repo = useContext(RepoContext)
  if (!repo) throw new Error("Repo was not found on RepoContext.")
  return repo
}
