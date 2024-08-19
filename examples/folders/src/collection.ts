import { DocLink, FolderDoc, FolderDocWithChildren, FolderDocWithMetadata, isFolderDoc } from "./types";
import { AutomergeUrl, DocHandle } from "@automerge/automerge-repo";

export type InvertedIndex = {
  childrenToParents: { [key: AutomergeUrl]: AutomergeUrl }
}

export function collectionToFolders(docs: { [key: AutomergeUrl]: DocHandle<unknown> }, root: AutomergeUrl): { root: FolderDocWithMetadata, invertedIndex: InvertedIndex } {
  const rootDoc = docs[root].docSync()
  if (isFolderDoc(rootDoc)) {
    const { folder: doc, invertedIndex } = folderDocWithChildren(docs, rootDoc, root)
    return {
      root: {
        rootFolderUrl: root,
        doc,
      },
      invertedIndex
    }
  } else {
    throw new Error("Root doc is not a folder")
  }
}

function folderDocWithChildren(docs: { [key: AutomergeUrl]: DocHandle<unknown> }, doc: FolderDoc, docUrl: AutomergeUrl): { folder: FolderDocWithChildren, invertedIndex: InvertedIndex } {
  const childDocs: (DocLink & { folderContents?: FolderDocWithChildren })[] = []

  const inverted: InvertedIndex = {
    childrenToParents: {}
  }

  for (const child of doc.docs) {
    const childDocLink: (DocLink & { folderContents?: FolderDocWithChildren }) = {
      name: child.name,
      type: child.type,
      url: child.url,
      folderContents: undefined
    }
    inverted.childrenToParents[child.url] = docUrl
    const childHandle = docs[child.url]
    if (childHandle == null) {
      throw new Error(`Child doc not found: ${child.url}`)
    }
    const childDoc = childHandle.docSync()

    if (child.type === "folder") {

      if (isFolderDoc(childDoc)) {
        childDocLink.name = childDoc.title
        const { folder: childFolderDoc, invertedIndex: childInverted } = folderDocWithChildren(docs, childDoc, child.url)
        childDocLink.folderContents = childFolderDoc
        for (const [childUrl, parentUrl] of Object.entries(childInverted.childrenToParents)) {
          inverted.childrenToParents[childUrl as AutomergeUrl] = parentUrl
        }
      }
    } else {
      if (childDoc && "contents" in childDoc && typeof childDoc.contents === "string") {
        const firstLine = childDoc.contents.split("\n")[0]
        if (firstLine.length > 0) {
          childDocLink.name = firstLine
        } else {
          childDocLink.name = "Untitled Essay"
        }
      }
    }

    childDocs.push(childDocLink)
  }

  return {
    folder: {
      title: doc.title,
      docs: childDocs,
    },
    invertedIndex: inverted
  }
}
