import { AnyDocumentId } from "@automerge/automerge-repo/slim"
import { ChangeFn, ChangeOptions, Doc } from "@automerge/automerge/slim/next"
import { useCallback, useEffect, useState } from "react"
import { useRepo } from "./useRepo.js"

/** A hook which returns a document identified by a URL and a function to change the document.
 *
 * @returns a tuple of the document and a function to change the document.
 * The document will be `undefined` if the document is not available in storage or from any peers
 *
 * @remarks
 * This requires a {@link RepoContext} to be provided by a parent component.
 * */
export function useDocument<T>(
  id?: AnyDocumentId
): [
  Doc<T> | undefined,
  (changeFn: ChangeFn<T>, options?: ChangeOptions<T> | undefined) => void
] {
  const repo = useRepo()
  const handle = id ? repo.find<T>(id) : null

  // a state value we use to trigger a re-render
  const [, setGeneration] = useState(0)
  const rerender = () => setGeneration(v => v + 1)

  useEffect(() => {
    if (!handle) {
      return
    }

    handle
      .doc()
      .then(rerender)
      .catch(e => console.error(e))

    handle.on("change", rerender)
    handle.on("delete", rerender)
    const cleanup = () => {
      handle.removeListener("change", rerender)
      handle.removeListener("delete", rerender)
    }

    return cleanup
  }, [handle])

  const changeDoc = useCallback(
    (changeFn: ChangeFn<T>, options?: ChangeOptions<T> | undefined) => {
      if (!handle) return
      handle.change(changeFn, options)
    },
    [handle]
  )

  return [handle?.docSync(), changeDoc] as const
}
