/// <reference lib="webworker" />
/**
 * Worker for the off-main-thread IndexedDB bench (StorageBench.browser.test.ts).
 * On message it writes N records to a fresh IDB in transactions of `perTxn`,
 * times the write on its OWN thread (unaffected by main-thread contention), and
 * posts the elapsed ms back. Self-contained (no imports) so it bundles cleanly
 * as a module worker.
 */
const rand = (n: number, seed: number): Uint8Array => {
  const o = new Uint8Array(n)
  let s = seed >>> 0 || 1
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    o[i] = s & 255
  }
  return o
}

const openDb = (name: string): Promise<IDBDatabase> =>
  new Promise((res, rej) => {
    const r = indexedDB.open(name, 1)
    r.onupgradeneeded = () => r.result.createObjectStore("s")
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })

const del = (name: string): Promise<void> =>
  new Promise(res => {
    const r = indexedDB.deleteDatabase(name)
    r.onsuccess = () => res()
    r.onerror = () => res()
    r.onblocked = () => res()
  })

self.onmessage = async (e: MessageEvent) => {
  const { n, perTxn, blobSize } = e.data as {
    n: number
    perTxn: number
    blobSize: number
  }
  const dbName = `bench-worker-${Math.random().toString(36).slice(2)}`
  const db = await openDb(dbName)
  const t0 = performance.now()
  let id = 0
  while (id < n) {
    await new Promise<void>((res, rej) => {
      const tx = db.transaction("s", "readwrite")
      const os = tx.objectStore("s")
      for (let r = 0; r < perTxn && id < n; r++) {
        id++
        const key = ["sdn", "c", "sid", "id" + id]
        os.put({ key, binary: rand(blobSize, id) }, key)
      }
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
  }
  const ms = performance.now() - t0
  db.close()
  await del(dbName)
  ;(self as unknown as Worker).postMessage({ ms })
}

export {}
