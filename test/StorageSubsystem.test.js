import assert from 'assert'
import StorageSubsystem from '../src/storage/StorageSubsystem.js'

const memory = {}
const memoryStorage = {
  load(id) { return memory[id] },
  save(id, data) { memory[id] = data },
  remove(id) { delete memory[id] }
}

describe('StorageSubsystem', () => {
  it('should accept a storage adapter at construction', () => {
    const storage = new StorageSubsystem(memoryStorage)
    // this is not a useful test
    assert(storage.storageAdapter === memoryStorage)
  })
})
