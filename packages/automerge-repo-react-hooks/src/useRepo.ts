import { Repo } from "@automerge/automerge-repo"
import { createContext, useContext } from "react"

export const RepoContext = createContext<Repo | null>(null)

export function useRepo(): Repo {
  const repo = useContext(RepoContext)
  if (!repo) throw new Error("Repo was not found on RepoContext.")
  return repo
}
