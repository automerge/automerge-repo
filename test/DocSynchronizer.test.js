import assert from 'assert'
import DocHandle from '../src/DocHandle.js'
import DocSynchronizer from '../src/network/DocSynchronizer.js'
import Automerge from 'automerge'

describe('DocSynchronizer', () => {
  const handle = new DocHandle("synced-doc")
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
