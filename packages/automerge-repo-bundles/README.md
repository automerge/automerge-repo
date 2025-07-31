# `automerge-repo-bundles`

A library for exporting and importing "bundles" of documents from
`automerge-repo`

## Why?

There are two important usecases for this package:

1. Exporting some kind of "initial" document state for users to collaborate on
2. Exporting documents for asynchronous collaboration (e.g. email)

`automerge-repo` doesn't provide any way to obtain a `DocHandle` without having
some network connection to a peer who has that document. This makes asynchronous
operations complicated. For example, if I want to write an application which
enables people to collaborate over email, what do I actually give my users to
send to each other?

`automerge-repo` does expose an `Repo.import` method, which can be used to
import a raw automerge document and you can pass a document ID to this method.
This allows a workflow where you export the document from the senders `Repo`,
then send the exported document, along with the document ID to the recipient who
then imports it using `Repo.import`. This is a) a bunch of boilerplate, and b) a
little risky as it's very important to ensure that the document ID is not used
twice for documents with different histories. `automerge-repo-bundles` provides
a standard way to export and import documents along with their IDs so that we
can avoid the boilerplate and the risk.

## Example

```typescript
import { Repo } from "@automerge/automerge-repo"
import { exportBundle, importBundle } from "@automerge/automerge-repo-bundles"

const alice = new Repo()
const doc = alice.create({ text: "foo" })
// Note the encode() method produces a stable, forwards compatible serialization
// format
const bundle = exportBundle(alice, [doc]).encode()

// Now somehow send the bundle to bob, maybe via email

const bob = new Repo()
// importedHandles is a map of document IDs which were imported
const importedHandles = importBundles(bob, [bundle])
const importedDoc = importedHandles.get(doc.url)
assert(importDoc.doc == { text: "foo" })
```
