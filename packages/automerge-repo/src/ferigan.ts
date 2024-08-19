import { EventEmitter } from "eventemitter3"
import { MessageContents, RepoMessage } from "./network/messages.js"
import { AutomergeUrl } from "./types.js"
import { Repo } from "./Repo.js"

const URL_RE = /automerge:([\w\d+/=]+)(?:\?([\w\d+/=&]*))*/

export interface Ferigan extends EventEmitter<FeriganEvents> {
  receiveMessage(message: RepoMessage): Promise<void>
  load(
    doc: ChangeLogId,
    since: ChangeHash[]
  ): AsyncIterableIterator<Progress<ChangeLog | undefined>>
  loadCollection(
    doc: ChangeLogId
  ): AsyncIterableIterator<Progress<Index | undefined>>
  append(
    doc: ChangeLogId,
    parents: ChangeHash[],
    changes: Uint8Array
  ): Promise<void>
  replace(
    doc: ChangeLogId,
    start: ChangeHash,
    end: ChangeHash,
    changes: Uint8Array
  ): Promise<void>
}

export function makeFerigan(repo: Repo): Ferigan {
  function fakeProgress<T>(): AsyncIterableIterator<Progress<T>> {
    return (async function*() {
      yield { type: "synchronizing_index" }
    })()
  }
  class FakeFerigan extends EventEmitter<FeriganEvents> {
    #repo: Repo

    constructor(repo: Repo) {
      super()
      this.#repo = repo
    }

    async receiveMessage(message: RepoMessage): Promise<void> { }
    load(
      doc: ChangeLogId
    ): AsyncIterableIterator<Progress<ChangeLog | undefined>> {
      return fakeProgress()
    }
    async *loadCollection(
      doc: ChangeLogId
    ): AsyncIterableIterator<Progress<Index | undefined>> {
      yield { type: "synchronizing_index" }

      const index: Index = { rootUrl: doc as AutomergeUrl, entries: [] }

      function findLinks(
        obj: unknown
      ): { url: string }[] {
        const links: { url: string; }[] = []

        const traverse = (value: unknown): void => {
          if (typeof value === "string") {
            const url = parseUrl(value)
            if (url != null) {
              links.push(url)
            }
          } else if (Array.isArray(value)) {
            value.forEach(traverse)
          } else if (typeof value === "object" && value !== null) {
            Object.values(value).forEach(traverse)
          }
        }

        traverse(obj)
        return links
      }

      const indexDoc = this.#repo.find(doc as AutomergeUrl)
      const handlesToProcess = [indexDoc]

      while (handlesToProcess.length > 0) {
        const handle = handlesToProcess.pop()
        if (!handle) {
          continue
        }

        const doc = await handle.doc()
        if (!doc) {
          continue
        }

        handle.on("change", change => {
          for (const patch of change.patches) {
            if (patch.action === "splice") {
              const possibleUrl = parseUrl(patch.value)
              if (possibleUrl != null) {
                this.emit("indexChanged", {
                  indexUrl: indexDoc.url,
                  change: {
                    type: "add",
                    url: possibleUrl.url,
                  }
                })
              }
            }
          }
        })

        const links = findLinks(doc)
        for (const { url: urlStr } of links) {
          const url = urlStr as AutomergeUrl
          if (index.entries.some(entry => entry === url)) {
            continue
          }
          index.entries.push(url)

          const childHandle = this.#repo.find(url as AutomergeUrl)
          handlesToProcess.push(childHandle)
        }
      }
      yield { type: "done", value: index }
    }
    append(
      doc: ChangeLogId,
      parents: ChangeHash[],
      changes: Uint8Array
    ): Promise<void> {
      return Promise.resolve()
    }
    replace(
      doc: ChangeLogId,
      start: ChangeHash,
      end: ChangeHash,
      changes: Uint8Array
    ): Promise<void> {
      return Promise.resolve()
    }
  }
  return new FakeFerigan(repo)
}

interface FeriganEvents {
  message: (event: {message: MessageContents}) => void
  changed: (event: {changedLog: ChangeLogId}) => void
  indexChanged: (event: {indexUrl: ChangeLogId, change: IndexChange}) => void
}

type IndexChange = {
  type: "add"
  url: AutomergeUrl
}

type ChangeLogId = string

type ChangeHash = string

type ChangeLog = { start: ChangeHash; end: ChangeHash; changes: Uint8Array }

export type Progress<T> =
  | { type: "synchronizing_index" }
  | {
    type: "synchronizing_docs"
    progress: number
    total: number
  }
  | { type: "done"; value: T }

export type Index = {
  rootUrl: AutomergeUrl,
  entries: AutomergeUrl[],
}

function parseUrl(
  urlStr: string
): { url: AutomergeUrl } | undefined {
  const match = urlStr.match(URL_RE)
  if (!match) {
    return undefined
  }
  const url = new URL(match[0])
  const normalisedUrl = `automerge:${url.pathname}`
  return { url: normalisedUrl as AutomergeUrl }
}
