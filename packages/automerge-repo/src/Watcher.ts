import { DocHandle, DocHandleEvents } from "./DocHandle.js"
import { Repo } from "./Repo.js"
import { DocumentId } from "./types.js"

type DocHandleEvent = keyof DocHandleEvents<unknown>

type Watched<T> = Map<DocumentId, DocHandle<T>>

type ChangeHandlers<T> = Partial<{
  [K in keyof DocHandleEvents<T>]: (
    ...args: [
      watched: Map<DocumentId, DocHandle<T>>,
      ...Parameters<DocHandleEvents<T>[K]>
    ]
  ) => Set<DocumentId> | undefined
}>

export class Watcher<T> {
  #repo: Repo
  #handlerWrappers: Partial<DocHandleEvents<T>>
  #watched: Watched<T>

  constructor(repo: Repo, handlers: ChangeHandlers<T>) {
    this.#repo = repo
    this.#watched = new Map()
    this.#handlerWrappers = Object.entries(handlers).reduce(
      (wrappers, [event, handler]) => {
        wrappers[event as DocHandleEvent] = payload => {
          try {
            // TODO: better type
            const newWatched = handler(this.#watched, payload as any)
            if (!newWatched) {
              return
            }
            this.watch(newWatched)
          } catch (e) {
            // TODO: handle error
            throw e
          }
        }
        return wrappers
      },
      {} as Partial<DocHandleEvents<T>>
    )
  }

  watch(ids: Set<DocumentId>) {
    const currentKeys = new Set(this.#watched.keys())
    const outgoing = except(currentKeys, ids)
    Array.from(outgoing).forEach(docId => {
      this.#unwatchDoc(docId)
    })

    const incoming = except(ids, currentKeys)
    Array.from(incoming).forEach(docId => {
      this.#watchDoc(docId)
    })
  }

  async #watchDoc(id: DocumentId) {
    const handle = await this.#repo.find<T>(id)

    Object.entries(this.#handlerWrappers).forEach(([event, handler]) => {
      // TODO: better type
      handle.on(event as DocHandleEvent, handler as any)
    })
    // fake a change event for the doc for the benefit of our handler
    // TODO: should this just be a separate event type?
    const changeHandler = this.#handlerWrappers['change'];
    if (changeHandler) {
      const doc = handle.doc();
      changeHandler({
        doc,
        handle,
        patches: [],
        patchInfo: {
          before: doc,
          after: doc,
          source: "emptyChange",
        }
      })
    }

    this.#watched.set(id, handle)
  }

  async #unwatchDoc(id: DocumentId) {
    const handle = await this.#repo.find<T>(id)

    Object.entries(this.#handlerWrappers).forEach(([event, handler]) => {
      // TODO: better type
      handle.off(event as DocHandleEvent, handler as any)
    })
    this.#watched.delete(id)
  }
}

function except<T = unknown>(
  s1: Readonly<Set<T>>,
  s2: Readonly<Set<T>>
): Set<T> {
  const result = new Set<T>()

  Array.from(s1).forEach(item => {
    if (s2.has(item)) {
      return
    }
    result.add(item)
  })

  return result
}
