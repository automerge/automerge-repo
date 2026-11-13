import type { Repo } from "@automerge/automerge-repo/slim"
import { RepoContext } from "./context.js"
import { useContext } from "solid-js"

/** grab the repo from the {@link RepoContext}, typed as `R` (a plain `Repo`
 * by default; not checked). {@link createRepoPrimitives} gives a checked one. */
export default function useRepo<R extends Repo = Repo>(): R {
  const repo = useContext(RepoContext)
  if (!repo) throw new Error("Please wrap me in a <RepoContext value={repo}>")
  return repo as R
}
