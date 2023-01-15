import { Repo } from "automerge-repo"
import { createContext } from "react"

export const RepoContext = createContext<Repo | null>(null)
