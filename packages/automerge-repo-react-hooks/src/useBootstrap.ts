import { useRepo } from "automerge-repo-react-hooks";
import { useEffect, useState, useMemo } from "react";

// Set URL hash
export const setHash = (hash: string, pushState = false) => {
  // Update URL hash
  history[pushState ? "pushState" : "replaceState"]("", "", "#" + hash);
  // Send fake hashchange event
  window.dispatchEvent(
    new HashChangeEvent("hashchange", {
      newURL: window.location.origin + window.location.pathname + hash,
      oldURL: window.location.href,
    })
  );
};

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

// Create a new document
export const createDocument = (repo, onCreate) => {
  const handle = repo.create(); // Create a new document
  if (onCreate) handle.change(onCreate); // Set initial state
  return handle;
};

/**
 * This hook is used to set up a single document as the base of an app session.
 * This is a common pattern for multiplayer apps with shareable URLs.
 * 
 * It will first check for the document ID in the URL hash:
 *   //myapp/#documentId=[document ID]
 * Failing that, it will check for a `documentId` key in localStorage.
 * Failing that, it will create a new document (and call onCreate with it).
 * The URL hash and localStorage will then be updated.
 * 
 * Finally, it will return the document ~~handle~~ ID.
 *
 * @param {function?} props.onCreate Function to call with doc, on doc creation
 * @param {string?} props.hashRouteKey Key to use in the URL hash - set to falsy to disable hash read/write
 * @param {string?} props.localStorageKey Key to use in localStorage - set to falsy to disable localStorage read/write
 * @param {function?} props.getDocumentId Function to get documentId from hash or localStorage
 * @param {function?} props.setDocumentId Function to set documentId in hash and localStorage
 * @returns documentId
 */
export const useBootstrap = ({
  onCreate = () => {},
  hashRouteKey = "documentId",
  localStorageKey = hashRouteKey || "documentId",
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

  // Try to get existing document; otherwise, create a new one
  const handle = useMemo(() => {
    const existingDocumentId = getDocumentId(hash);
    return existingDocumentId
      ? repo.find(existingDocumentId) // TODO: Handle bad existingDocumentId
      : createDocument(repo, onCreate);
  }, [hash, repo, onCreate]);

  // Update hashroute & localStorage on changes
  useEffect(() => setDocumentId(handle.documentId), [hash, handle.documentId]);

  // TODO: Should we return a handle, not a documentID?
  return handle.documentId;
};
