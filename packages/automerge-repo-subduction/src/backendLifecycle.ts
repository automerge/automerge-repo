const closed = new WeakSet<object>()
const listeners = new WeakMap<object, Set<() => void>>()

/** Internal lifecycle notification, including closure while no socket is connected. */
export function observeBackendClose(
  backend: object,
  callback: () => void
): () => void {
  if (closed.has(backend)) {
    callback()
    return () => {}
  }
  let callbacks = listeners.get(backend)
  if (!callbacks) listeners.set(backend, (callbacks = new Set()))
  callbacks.add(callback)
  return () => {
    callbacks.delete(callback)
  }
}

export function notifyBackendClosed(backend: object): void {
  closed.add(backend)
  const callbacks = listeners.get(backend)
  listeners.delete(backend)
  for (const callback of callbacks ?? []) callback()
}
