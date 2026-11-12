# React Hooks for Automerge Repo

These hooks are provided as helpers for using Automerge in your React project.

#### [useLocalAwareness](./src/useLocalAwareness.ts) & [useRemoteAwareness](./src/useRemoteAwareness.ts)

These hooks implement ephemeral awareness/presence, similar to [Yjs Awareness](https://docs.yjs.dev/getting-started/adding-awareness).
They allow temporary state to be shared, such as cursor positions or peer online/offline status.

Ephemeral messages are replicated between peers, but not saved to the Automerge doc, and are used for temporary updates that will be discarded.

They need a handle with ephemeral messaging, which the Repo's backend provides (e.g. the Subduction backend).

#### [useRepo/RepoContext](./src/useRepo.ts)

Use RepoContext to set up react context for an Automerge repo.
Use useRepo to lookup the repo from context.
Most hooks depend on RepoContext being available.

#### [createRepoHooks](./src/createRepoHooks.ts)

A provider and `useRepo`, `useDocHandle` and `useDocHandles` typed for one Repo, with
the features its backend adds to handles. See
[Typed handles](../automerge-react/README.md#typed-handles) for this and the other
ways to type handles (a handle type per call, or registering the Repo's type).

#### [useDocument](./src/useDocument.ts)

Return a document & updater fn, by ID.

The updater applies edits immediately and returns `Promise<void>` for persistence.
Await it to observe persistence failures. Await `repo.create()` or `repo.import()`
before passing the resulting handle's URL to a hook.

#### [useDocHandle](./src/useDocHandle.ts)

Return a handle, by ID.

Loading uses `repo.find()`. Synchronous initial values still use the deprecated
progress peek; replacing that peek with a promise would introduce loading flicker.
