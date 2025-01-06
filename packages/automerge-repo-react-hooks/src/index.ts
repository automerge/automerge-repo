/**
 * @packageDocumentation
 *
 * # React Hooks for Automerge Repo
 *
 * These hooks are provided as helpers for using Automerge in your React project.
 *
 * #### {@link useRepo}/{@link RepoContext}
 * Use RepoContext to set up react context for an Automerge repo.
 * Use useRepo to lookup the repo from context.
 * Most hooks depend on RepoContext being available.
 *
 * #### {@link useDocument}
 * Return the current state of a document (or undefined) and a change function.
 *
 * #### {@link useHandle}
 * Return a DocHandle by passing in a DocumentURL.
 *
 * #### {@link useLocalAwareness} & {@link useRemoteAwareness}
 * These hooks implement ephemeral awareness/presence, similar to [Yjs Awareness](https://docs.yjs.dev/getting-started/adding-awareness).
 * They allow temporary state to be shared, such as cursor positions or peer online/offline status.
 *
 * Ephemeral messages are replicated between peers, but not saved to the Automerge doc, and are used for temporary updates that will be discarded.
 *
 */
export { useDocument } from "./useDocument.js"
export { useDocuments } from "./useDocuments.js"
export { useDocHandle } from "./useDocHandle.js"
export { RepoContext, useRepo } from "./useRepo.js"
export {
  useLocalAwareness,
  type UseLocalAwarenessProps,
} from "./useLocalAwareness.js"
export {
  useRemoteAwareness,
  type PeerStates,
  type Heartbeats,
  type UseRemoteAwarenessProps,
} from "./useRemoteAwareness.js"
