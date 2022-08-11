import assert from 'assert'
import { StorageSubsystem } from '../src'
import Repo from '../src/Repo'
import MemoryStorageAdapter from '../src/storage/interfaces/MemoryStorageAdapter'

describe('Repo', () => {
  it('should assign a UUID on create()', () => {
    const repo = new Repo(new StorageSubsystem(new MemoryStorageAdapter))
    const handle = repo.create()
    assert(handle.documentId)
  })
})
