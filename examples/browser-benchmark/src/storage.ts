const metadataDatabase = "automerge-repo-bench-meta"

function open(name: string, store: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(store)
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

export async function seedInfo(
  key: string
): Promise<{ hash: string; urls: string[]; revision?: string } | undefined> {
  const db = await open(metadataDatabase, "seeds")
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("seeds", "readonly")
      const request = tx.objectStore("seeds").get(key)
      request.onsuccess = () => resolve(request.result)
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export async function saveSeedInfo(
  key: string,
  value: { hash: string; urls: string[]; revision?: string }
) {
  const db = await open(metadataDatabase, "seeds")
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("seeds", "readwrite")
      tx.objectStore("seeds").put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () =>
      reject(new Error(`Database deletion blocked: ${name}`))
  })
}

export async function storeSize(
  name: string
): Promise<{ keys: number; bytes: number }> {
  const db = await open(name, "unused")
  try {
    const stores = [...db.objectStoreNames]
    if (stores.length !== 1)
      throw new Error(`Unexpected stores in ${name}: ${stores}`)
    return await new Promise((resolve, reject) => {
      let keys = 0
      let bytes = 0
      const tx = db.transaction(stores[0], "readonly")
      const cursor = tx.objectStore(stores[0]).openCursor()
      cursor.onsuccess = () => {
        if (!cursor.result) return
        keys++
        const value = cursor.result.value
        bytes += value?.byteLength ?? value?.binary?.byteLength ?? 0
        cursor.result.continue()
      }
      tx.oncomplete = () => resolve({ keys, bytes })
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
