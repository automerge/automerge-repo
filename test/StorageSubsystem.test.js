import assert from 'assert'
import StorageSubsystem from '../src/storage/StorageSubsystem.js'
import LocalForageAdapter from '../src/storage/interfaces/LocalForageStorageAdapter.js'
import crypto from 'crypto'

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

/* these tests are browser only. right. */
describe('LocalForageStorageAdapter', () => {
  const localForage = new LocalForageAdapter()
  const buf = crypto.randomBytes(10)
  const array = new Uint32Array(buf)
  
  it('should be able to save and retrieve', async () => {
    localForage.save('test-key', array)
    const result = await localForage.load('test-key')
    console.log(array, result)
    assert(result == array)
  })

  it('should be able to remove data', async () => {
    localForage.save('test-key', array)
    localForage.remove('test-key')
    const result = await localForage.load('test-key')
    assert(result.length === 0)
  })

  after(() => {
    localForage.remove('test-key')
  })
})