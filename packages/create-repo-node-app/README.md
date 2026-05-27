# Scaffolding for a node `automerge-repo` app

This generates a simple TypeScript project with the dependencies for a repo that
synchronises over WebSockets and stores data on the filesystem.

## How to use

```
npm create @automerge/repo-node-app <your project name>
```

(or `pnpm create`, `yarn create`, `bun create` — the scaffold detects your
package manager.)

The project runs with Node's built-in TypeScript support, so there is no build
step. Change into the directory, install dependencies, and start editing
`index.ts`.
