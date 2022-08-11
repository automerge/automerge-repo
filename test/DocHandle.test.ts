import assert from 'assert'
import DocHandle from '../src/DocHandle'

describe('DocHandle', () => {
  it('should take the UUID passed into it', () => {
    const handle = new DocHandle('test-document-id')
    assert(handle.documentId === 'test-document-id')
  })
})
