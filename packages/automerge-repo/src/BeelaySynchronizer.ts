import { beelay, Heads, next as Automerge } from "@automerge/automerge/slim"
import { DELETED, DocHandle, REQUESTING } from "./DocHandle.js"
import { AutomergeUrl, DocumentId } from "./types.js"
import debug from "debug"
import { parseAutomergeUrl } from "./AutomergeUrl.js"

export class BeelaySynchronizer {
  #log: debug.Debugger = debug("automerge-repo:BeelaySynchronizer")
  beelay: Promise<beelay.Beelay>
  handles: Map<DocumentId, DocHandle<any>> = new Map()
  lastSaved: Map<DocumentId, Heads> = new Map()
  denyList: Set<DocumentId> = new Set()

  constructor(beelay: Promise<beelay.Beelay>, denyList: Array<AutomergeUrl>) {
    this.denyList = new Set()
    this.beelay = beelay
    for (const url of denyList) {
      try {
        const parsed = parseAutomergeUrl(url)
        this.denyList.add(parsed.documentId)
      } catch (error) {}
    }
    this.beelay.then(beelay => {
      this.#log = debug(
        `automerge-repo:BeelaySynchronizer:${shortHex(beelay.peerId)}`
      )
      beelay.on("doc-event", ({ docId, event }) => {
        if (event.type === "data") {
          const handle = this.handles.get(docId as DocumentId)
          if (handle == null) {
            return
          }
          handle.update(d => {
            if (d != null) {
              return Automerge.loadIncremental(d, event.data.contents)
            } else {
              return Automerge.load(event.data.contents)
            }
          })
        }
      })
    })
  }

  addDocument(handle: DocHandle<unknown>) {
    if (beelay.parseBeelayDocId(handle.documentId) == null) {
      this.#log(`${handle.documentId} is not a valid beelay document ID`)
      permanentlyUnavailable(handle)
      return
    }
    if (this.denyList.has(handle.documentId)) {
      this.#log(`${handle.documentId} is on the deny list`)
      permanentlyUnavailable(handle)
      return
    }
    if (this.handles.has(handle.documentId)) {
      return
    }
    this.#log("adding doc to beelay synchronizer: ", handle.documentId)
    this.handles.set(handle.documentId, handle)
    this.load(handle)
  }

  onHandleChanged(
    beelay: beelay.Beelay,
    handle: DocHandle<unknown>,
    doc: Automerge.Doc<any>
  ) {
    this.#log("handle changed ", handle.documentId)
    this.save(beelay, handle)
  }

  async load(handle: DocHandle<unknown>) {
    let beelayReady = false
    let found = false
    handle.on("requested", () => {
      if (!found && beelayReady) {
        this.#log(`marking ${handle.documentId} unavailable`)
        handle.unavailableBeelay()
      }
    })
    const beelay = await this.beelay
    beelayReady = true

    this.#log(`loading document ${handle.documentId} from beelay`)
    let beelayCommits = await beelay.loadDocument(handle.documentId)
    this.#log(`load for document ${handle.documentId} complete`)
    if (beelayCommits != null) {
      found = true
      this.handleCommits(handle, beelay, beelayCommits)
    } else {
      this.#log(`document ${handle.documentId} not found in Beelay`)
      if (handle.state === REQUESTING) {
        handle.unavailableBeelay()
      }
      let beelayCommits = await beelay.waitForDocument(handle.documentId)
      found = true
      this.#log("unavailable document was found")
      this.handleCommits(handle, beelay, beelayCommits)
    }
  }

  async handleCommits(
    handle: DocHandle<unknown>,
    beelay: beelay.Beelay,
    beelayCommits: beelay.CommitOrBundle[]
  ) {
    const combinedData = new Uint8Array(
      beelayCommits.flatMap(commit => Array.from(commit.contents))
    )
    handle.update(d => {
      if (d != null) {
        return Automerge.loadIncremental(d, combinedData)
      } else {
        let result = Automerge.init()
        return Automerge.loadIncremental(result, combinedData)
      }
    })
    handle.on("heads-changed", ({ handle, doc }) => {
      this.onHandleChanged(beelay, handle, doc)
    })
    await this.save(beelay, handle)
  }

  async save(beelay: beelay.Beelay, handle: DocHandle<unknown>) {
    let lastSaved = this.lastSaved.get(handle.documentId)
    let newChanges: Automerge.Change[] = []
    this.#log("saving")
    newChanges = Automerge.getChanges(
      Automerge.view(handle.unsafeDoc, lastSaved || []),
      handle.unsafeDoc
    )
    this.#log(`newChanges.length ${newChanges.length}`)
    if (newChanges.length === 0) {
      this.#log("no new changes to save")
      return
    }

    const commits = newChanges.map(c => {
      const decoded = Automerge.decodeChange(c)
      return {
        hash: decoded.hash,
        parents: decoded.deps,
        contents: c,
      }
    })
    let currentHeads = Automerge.getHeads(handle.unsafeDoc)
    this.#log("adding commits")
    await beelay.addCommits({ docId: handle.documentId, commits })

    // Reload as the last saved heads might have changed while we were saving
    lastSaved = this.lastSaved.get(handle.documentId) || []
    let frontier = Automerge.frontier(handle.unsafeDoc, [
      ...lastSaved,
      ...currentHeads,
    ])
    this.#log(`saved ${handle.documentId} at ${frontier}`)
    this.lastSaved.set(handle.documentId, frontier)
  }
}

function permanentlyUnavailable(handle: DocHandle<unknown>) {
  handle.on("requested", () => {
    handle.unavailableBeelay()
  })
}

function shortHex(fullHex: string): string {
  const start = fullHex.slice(0, 4)
  const end = fullHex.slice(-4)
  return `${start}...${end}`
}
