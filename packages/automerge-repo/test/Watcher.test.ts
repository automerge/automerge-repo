import { describe, expect, it } from "vitest"
import { Repo } from "../src/Repo.js"
import { DummyNetworkAdapter } from "../src/helpers/DummyNetworkAdapter.js"
import { DummyStorageAdapter } from "../src/helpers/DummyStorageAdapter.js"
import { DocumentId } from "../src/types.js"

import { Watcher } from "../src/Watcher.js"
import { Doc, generateAutomergeUrl } from "../src/index.js"
import { parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { pause } from "../src/helpers/pause.js"

describe("Watcher", () => {
  describe("repo", () => {
    const setup = ({ startReady = true } = {}) => {
      const storageAdapter = new DummyStorageAdapter()
      const networkAdapter = new DummyNetworkAdapter({ startReady })

      const repo = new Repo({
        storage: storageAdapter,
        network: [networkAdapter],
        saveDebounceRate: 1,
      })
      return { repo, storageAdapter, networkAdapter }
    }

    it("loads a document tree", async () => {
      const { repo } = setup()

      const tree = generateDirTree(repo)

      let latestHandles: Set<DocumentId>;

      const watcher = new Watcher<DirEntry>(repo, {
        change: (handles, payload) => {
          const newHandles = new Set(handles.keys())
          const { handle, doc } = payload

          if (doc.type === "leaf") {
            return newHandles
          }

          newHandles.add(handle.documentId)

          const entryIds = doc.contents

          entryIds.forEach(docId => {
            newHandles.add(docId)
          })

          latestHandles = newHandles;
          return newHandles
        },
        delete: (handles, payload) => {
          const newHandles = new Set(handles.keys())
          const { handle } = payload
          // TODO: what's up with the type here?
          const doc = handle.doc()
          if (doc.type === "leaf") {
            return newHandles
          }

          const entryIds = doc.contents

          entryIds.forEach(docId => {
            // Each node manages an exclusive subset of the full tree contents,
            // so we can be sure these documents do not appear anywhere else and
            // can be deleted when this directory is deleted.
            newHandles.delete(docId)
          })

          latestHandles = newHandles;
          return newHandles
        },
      })

      const { root, allDocs } = tree;

      watcher.watch(new Set([root.documentId]))

      await pause();

      expect(latestHandles.size).toBe(allDocs.length);
    })
  })
})

function debug(repo: Repo, documentIds: DocumentId[]) {
  documentIds.slice().sort().forEach(async (docId) => {
    const doc = await repo.find(docId);
    console.log(docId, JSON.stringify(doc.doc()))
  })
}

function generateLeaf(repo: Repo) {
  const { documentId } = parseAutomergeUrl(generateAutomergeUrl());
  return repo.create({
    type: "leaf",
    contents: documentId,
  });
}

function generateDir(repo: Repo, ...documents: DocumentId[]) {
  return repo.create<DirEntry>({
    type: "folder",
    contents: documents
  });
}

function generateDirTree(repo: Repo) {
  const doc1 = generateLeaf(repo);
  const dir1 = generateDir(repo, doc1.documentId);
  const doc3 = generateLeaf(repo);
  const doc4 = generateLeaf(repo);
  const dir2 = generateDir(repo, doc3.documentId, doc4.documentId);
  const doc5 = generateLeaf(repo);
  const doc6 = generateLeaf(repo);
  const dir3 = generateDir(repo, doc5.documentId, doc6.documentId, dir2.documentId);
  const root = generateDir(repo, dir1.documentId, dir3.documentId);

  const allDocs = [
    doc1, dir1, doc3, doc4, dir2, doc5, doc6, dir3, root
  ].map((handle) => handle.documentId);

  return {
    root,
    allDocs,
  }
}

type DirEntry = Doc<
  | {
      type: "folder"
      contents: DocumentId[]
    }
  | {
      type: "leaf"
      contents: DocumentId
    }
>
