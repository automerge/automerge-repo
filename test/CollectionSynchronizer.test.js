import assert from 'assert'
import DocHandle from '../src/DocHandle.js'
import CollectionSynchronizer from '../src/network/CollectionSynchronizer.js'
import Automerge from 'automerge'

describe('CollectionSynchronizer', () => {
  const handle = new DocHandle("synced-doc")
  handle.replace(Automerge.init())
  const synchronizer = new CollectionSynchronizer()
  
  it('should probably do something')
})
