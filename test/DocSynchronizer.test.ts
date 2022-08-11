import assert from 'assert'
import Automerge from 'automerge-js'
import DocHandle from '../src/DocHandle'
import DocSynchronizer from '../src/synchronizer/DocSynchronizer'

describe('DocSynchronizer', () => {
  const handle = new DocHandle('synced-doc')
  handle.replace(Automerge.init())
  const docSynchronizer = new DocSynchronizer(handle)

  it('should take the handle passed into it', () => {
    assert(docSynchronizer.handle === handle)
  })
  it('should emit a syncMessage when beginSync is called', (done) => {
    docSynchronizer.on('message', () => done())
    docSynchronizer.beginSync('imaginary-peer-id')
  })
})
