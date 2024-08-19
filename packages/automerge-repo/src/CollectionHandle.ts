import { EventEmitter } from "eventemitter3"
import { Ferigan, Index } from "./ferigan.js";
import { AutomergeUrl, DocumentId } from "./types.js";
import { Beelay } from "beelay";
import { parseAutomergeUrl } from "./AutomergeUrl.js";

export type CollectionHandleEvents = {
  doc_added: (url: AutomergeUrl) => void
}

export class CollectionHandle extends EventEmitter<CollectionHandleEvents> {
  //#index: Index
  #beelay: Beelay
  //#ferigan: Ferigan
  #rootId: DocumentId
  #rootUrl: AutomergeUrl
  #entries: AutomergeUrl[] = []

  get index(): Index {
    return {
      rootUrl: this.#rootUrl,
      entries: this.#entries
    }
  }

  constructor(belay: Beelay, rootUrl: AutomergeUrl, entries: AutomergeUrl[]) {
    super()
    this.#rootUrl = rootUrl
    this.#rootId = parseAutomergeUrl(rootUrl).documentId
    this.#beelay = belay
    this.#entries = entries

    //this.#ferigan.on("indexChanged", ({indexUrl, change}) => {
      //if (indexUrl != this.#index.rootUrl) {
        //return
      //}

      //if (change.type === "add") {
        //this.#index.entries.push(change.url)
        //this.emit("doc_added", change.url as AutomergeUrl) 
      //}
    //})
  }

  add(url: AutomergeUrl): void {
    this.#entries.push(url)
    let docId = parseAutomergeUrl(url).documentId
    this.#beelay.addLink({from: this.#rootId, to: docId})
  }
}

