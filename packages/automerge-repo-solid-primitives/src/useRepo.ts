import type { Repo } from "@automerge/automerge-repo/slim"
import { RepoContext } from "./context.js"
import { useContext } from "solid-js"

/** grab the repo from the {@link RepoContext} */
export default function useRepo(): Repo {
  const repo = useContext(RepoContext)
  if (!repo) throw new Error("Please wrap me in a <RepoContext value={repo}>")
  return repo
}
