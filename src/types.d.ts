declare module "automerge-js" {
  type Doc = { [key: string]: any }
  function use(wasm)
  function init()
  function generateSyncMessage(doc, syncState)
  function receiveSyncMessage(doc, syncState, message)
  function applyChanges(doc, changes)
  function save(doc)
  function load(binary)
  function initSyncState()
  function getBackend(doc)
  function change(doc, callback)
  function getChanges(doc, doc)
};