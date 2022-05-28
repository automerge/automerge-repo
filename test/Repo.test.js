import assert from 'assert'
import Repo from '../src/Repo.js'

describe('Repo', () => {
  it('should assign a UUID on create()', () => {
    const repo = new Repo()
    const handle = repo.create()
    assert(handle.documentId)
  })
})
