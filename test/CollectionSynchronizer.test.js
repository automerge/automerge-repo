import assert from 'assert'
import DocHandle from '../src/DocHandle.js'
import CollectionSynchronizer from '../src/synchronizer/CollectionSynchronizer.js'
import Automerge from 'automerge-js'

describe('CollectionSynchronizer', () => {
  const handle = new DocHandle("synced-doc")
  handle.replace(Automerge.init())
  const synchronizer = new CollectionSynchronizer()
  
  it('should probably do something')
})
