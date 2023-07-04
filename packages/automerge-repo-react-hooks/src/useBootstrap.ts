import { useRepo } from "automerge-repo-react-hooks";
import { DocumentId } from "automerge-repo";
import { useEffect, useState } from "react";

// Set URL hash
export const setHash = (hash: string, pushState = false) =>
  void history[pushState ? "pushState" : "replaceState"]("", "", "#" + hash);

// Get current URL hash
export const useHash = () => {
  const [hashValue, setHashValue] = useState(window.location.hash);
  useEffect(() => {
    const handler = () => void setHashValue(window.location.hash);
    window.addEventListener("hashchange", handler);
    return () => void window.removeEventListener("hashchange", handler);
  }, []);
  return hashValue;
};

// Get a key from a query-param-style hash URL
export const getQueryParamValue = (key: string, hash) =>
  hash.match(new RegExp(`${key}=([^&]*)`))?.[1];

export const createDocument = (repo, onCreate) => {
  const handle = repo.create(); // Create a new document
  if (onCreate) handle.change(onCreate); // Set initial state
  return handle;
};

export const useBootstrap = ({
  onCreate = () => {},
  hashRouteKey = "id",
  localStorageKey = "documentId",
  getDocumentId = (hash) =>
    getQueryParamValue(hashRouteKey, hash) ??
    (localStorageKey && localStorage.getItem(localStorageKey)),
  setDocumentId = (documentId) => {
    // Only set hashroute if document ID changed
    if (documentId !== getQueryParamValue(hashRouteKey, window.location.hash))
      setHash(`${hashRouteKey}=${documentId}`);
    if (localStorageKey) localStorage.setItem(localStorageKey, documentId);
  },
} = {}) => {
  const repo = useRepo();
  const hash = useHash();

  const existingDocumentId = getDocumentId(hash) as DocumentId | undefined;

  const handle = existingDocumentId
    ? repo.find(existingDocumentId) // TODO: Handle bad existingDocumentId
    : createDocument(repo, onCreate);

  // Update hashroute & localStorage on changes
  useEffect(() => setDocumentId(handle.documentId), [hash, handle.documentId]);

  // TODO: Should we return a handle, not a documentID?
  return handle.documentId;
};
