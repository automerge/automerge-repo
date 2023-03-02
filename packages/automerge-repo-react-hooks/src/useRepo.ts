import { Repo } from "automerge-repo"
import { createContext, useContext } from "react"

const RepoContext = createContext<Repo | null>(null)

export function useRepo(): Repo {
  const repo = useContext(RepoContext)
  if (!repo) throw new Error("Repo was not found on RepoContext.")
  return repo
}
