import assert from 'assert'
import * as Automerge from 'automerge-js'
import { Repo, StorageSubsystem } from '../src'
import DocHandle from '../src/DocHandle'
import MemoryStorageAdapter from '../src/storage/interfaces/MemoryStorageAdapter'
import CollectionSynchronizer from '../src/synchronizer/CollectionSynchronizer'

describe('CollectionSynchronizer', () => {
  const handle = new DocHandle('synced-doc')
  handle.replace(Automerge.init())
  const repo = new Repo(new StorageSubsystem(new MemoryStorageAdapter()))
  const synchronizer = new CollectionSynchronizer(repo)

  it('should probably do something')
})
