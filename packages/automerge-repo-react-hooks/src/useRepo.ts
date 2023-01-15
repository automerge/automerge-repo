import { Repo } from "automerge-repo"
import { useContext } from "react"
import { RepoContext } from "./RepoContext"

export function useRepo(): Repo {
  const repo = useContext(RepoContext)
  if (!repo) throw new Error("Repo was not found on RepoContext.")
  return repo
}
