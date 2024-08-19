import { AutomergeUrl } from "@automerge/automerge-repo"

export type DatatypeId = "folder" | "essay" | "unknown"

export function isDatatypeId(value: unknown): value is DatatypeId {
  return value === "folder" || value === "essay" || value === "unknown"
}

export type DocLink = {
  name: string;
  type: DatatypeId;
  url: AutomergeUrl;
};

export function isDocLink(value: unknown): value is DocLink {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const obj = value as Record<string, unknown>
  return typeof obj.name === "string" && isDatatypeId(obj.type) && typeof obj.url === "string"
}

export type DocLinkWithFolderPath = DocLink & {
  /** A list of URLs to folder docs that make up the path to this link.
   *  Always contains at least one URL: the root folder for the user
   */
  folderPath: AutomergeUrl[];
};

export type FolderDoc = {
  title: string;
  docs: DocLink[];
};

export function isFolderDoc(value: unknown): value is FolderDoc {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const obj = value as Record<string, unknown>
  return typeof obj.title === "string" && Array.isArray(obj.docs) && obj.docs.every(isDocLink)
}

// A type representing a folder where the contents are either links to regular docs,
// or links to folders, in which case we have access to the contents of the folder
export type FolderDocWithChildren = Omit<FolderDoc, "docs"> & {
  docs: (DocLink & {
    folderContents?: FolderDocWithChildren;
  })[];
};

export type FolderDocWithMetadata = {
  rootFolderUrl: AutomergeUrl;
  doc: FolderDocWithChildren;
};

