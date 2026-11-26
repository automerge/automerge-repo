# React Hooks for Automerge Repo

These hooks are provided as helpers for using Automerge in your React project.

#### [createRepoHooks](./src/createRepoHooks.ts)

The recommended way to use the hooks. It makes a provider and the hooks
(`useRepo`, `useDocument`, `useDocuments`, `useDocHandle`, `useDocHandles`,
`usePresence`), typed for one Repo, with the features its backend adds to handles.
Make them once next to the Repo and import every hook from there:

```ts
export const repo = new Repo({ backend })
export const { RepoProvider, useRepo, useDocument, useDocHandle } =
  createRepoHooks(repo)
```

Each call makes its own provider, so several Repos can be used at once. See
[React usage](../automerge-react/README.md#react-usage).

The hooks are also exported directly, for existing apps and shared components; they
read the Repo from `RepoContext` and give plain handles.

#### [useRepo/RepoContext](./src/useRepo.ts)

Use RepoContext to set up react context for an Automerge repo, without the factory.
Use useRepo to lookup the repo from context.
The package-level hooks depend on RepoContext being available; the factory's
provider sets it too.

#### [useDocument](./src/useDocument.ts)

Return a document & updater fn, by ID.

The updater applies edits immediately and returns `Promise<void>` for persistence.
Await it to observe persistence failures. Await `repo.create()` or `repo.import()`
before passing the resulting handle's URL to a hook.

#### [useDocHandle](./src/useDocHandle.ts)

Return a handle, by ID.

Loading uses `repo.find()`. Synchronous initial values still use the deprecated
progress peek; replacing that peek with a promise would introduce loading flicker.
