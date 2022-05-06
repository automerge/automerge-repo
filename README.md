# automerge-repo

Folks building automerge-based applications often have similar requirements for storage and networking. While the core of Automerge is designed to allow a user to use or ignore any of its capabilities and plug it into many systems, this class is designed to provide straightforward access to relatively default behaviour for synchronization and storage.

# Usage
```js
# Create a repository, passing in a StorageAdapter and NetworkAdapter
const repo = new Repo(StorageAdapter(), new NetworkAdapter('ws://localhost:8080'))

# pick a globally unique UUID specific to this document
# or, you know, just use a hardcoded string and deal with the consequences later
let docId = window.location.hash.replace(/^#/, '') || 'my-todo-list'

# now try to load the document from localstorage, or failing that create a new one
# weirdly, this works with synchronization from another source because the other source
# will be able to merge with your fresh, empty document
# (though not if you start editing it right away. what the hell is wrong with us.)
let doc = await repo.load(docId)
if (!doc) { doc = repo.create(docId) }

# get an event every time the document is changed either locally or remotely
# the data is { documentId: string, doc: Automerge }
doc.addEventListener('change', (ev) => render(ev.detail))

# the current API is not great and you've already missed the first change notification by now
# so you're going to have to call your first render() manually.
render({ doc: doc.value() })
```

# Example

Sample code is provided in `./example`. Run it with `yarn run demo`, then go to [http://localhost:8081/example] to see it running. Note that unless you're already running the local-first-web/relay server on port 8080 it won't work.

