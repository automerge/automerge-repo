import * as A from "@automerge/automerge/next"

export const patchesFromChange = <T>(
  doc: A.Doc<T>,
  change: A.ChangeFn<T>,
  options: A.ChangeOptions<T> = {}
) => {
  let patches: A.Patch[] | undefined
  let patchInfo: A.PatchInfo<T> | undefined

  const originalCallback = options.patchCallback
  options = {
    ...options,
    patchCallback: (p, pInfo) => {
      patches = p
      patchInfo = pInfo

      // if a patchCallback was provided in the original options, call it
      if (originalCallback) {
        originalCallback(p, pInfo)
      }
    },
  }

  const newDoc = A.change(doc, options, change)

  return {
    patches: patches ?? [],
    patchInfo: patchInfo ?? {
      after: newDoc,
      source: "change",
    },
  }
}
