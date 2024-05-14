# React Hooks for Automerge Repo

These hooks are provided as helpers for using Automerge in your React project.

#### [useLocalAwareness](./src/useLocalAwareness.ts) & [useRemoteAwareness](./src/useRemoteAwareness.ts)

These hooks implement ephemeral awareness/presence, similar to [Yjs Awareness](https://docs.yjs.dev/getting-started/adding-awareness).
They allow temporary state to be shared, such as cursor positions or peer online/offline status.

Ephemeral messages are replicated between peers, but not saved to the Automerge doc, and are used for temporary updates that will be discarded.

#### [useRepo/RepoContext](./src/useRepo.ts)

Use RepoContext to set up react context for an Automerge repo.
Use useRepo to lookup the repo from context.
Most hooks depend on RepoContext being available.

#### [useDocument](./src/useDocument.ts)

Return a document & updater fn, by ID.

#### [useHandle](./src/useHandle.ts)

Return a handle, by ID.
