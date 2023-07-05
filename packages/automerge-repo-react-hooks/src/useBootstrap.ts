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

// Get a key from a query-param-style URL hash
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
 *
 * The URL and localStorage will then be updated.
 * Finally, it will return the document ID.
 *
 * @param {string?} props.urlHashKey Key to use in the URL hash; set to falsy to disable URL hash
 * @param {string?} props.localStorageKey Key to use in localStorage; set to falsy to disable localStorage
 * @param {function?} props.onCreate Function to call with doc, on doc creation
 * @param {function?} props.onInvalidDocumentId Function to call if documentId is invalid; signature (error) => (repo, onCreate)
 * @param {function?} props.getDocumentId Function to get documentId from hash or localStorage
 * @param {function?} props.setDocumentId Function to set documentId in hash and localStorage
 * @returns documentId
 */
export const useBootstrap = ({
  urlHashKey = "documentId",
  localStorageKey = urlHashKey || "documentId",
  onCreate = () => {},
  onInvalidDocumentId = (error) => {
    // console.warn("Invalid document ID", error);
    return createDocument;
  },
  getDocumentId = (hash) =>
    (urlHashKey && getQueryParamValue(urlHashKey, hash)) ||
    (localStorageKey && localStorage.getItem(localStorageKey)),
  setDocumentId = (documentId) => {
    if (urlHashKey) {
      // Only set URL hash if document ID changed
      if (documentId !== getQueryParamValue(urlHashKey, window.location.hash))
        setHash(`${urlHashKey}=${documentId}`);
    }
    if (localStorageKey) localStorage.setItem(localStorageKey, documentId);
  },
} = {}) => {
  const repo = useRepo();
  const hash = useHash();

  // Try to get existing document; else create a new one
  const handle = useMemo(() => {
    const existingDocumentId = getDocumentId(hash);
    try {
      return existingDocumentId
        ? repo.find(existingDocumentId)
        : createDocument(repo, onCreate);
    } catch (error) {
      // Presumably the documentId was invalid
      if (existingDocumentId) return onInvalidDocumentId(error)(repo, onCreate);
      // Forward other errors
      throw error;
    }
  }, [hash, repo, onCreate]);

  // Update hashroute & localStorage on changes
  useEffect(() => setDocumentId(handle.documentId), [hash, handle.documentId]);

  // TODO: Should we return a handle, not a documentID?
  return handle.documentId;
};
