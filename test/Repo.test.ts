import assert from 'assert'
import { StorageSubsystem } from '../src'
import Repo from '../src/Repo'

describe('Repo', () => {
  it('should assign a UUID on create()', () => {
    const repo = new Repo(new StorageSubsystem())
    const handle = repo.create()
    assert(handle.documentId)
  })
})
