export type StorageStats = Record<
  "load" | "save" | "list" | "remove" | "loadPrefix",
  { calls: number; elapsedMs: number; values: number }
>

export type Handle<T> = {
  url: string
  doc(): T | undefined
  on(event: "change", listener: () => void): unknown
  change(
    callback: (doc: T) => void,
    options: { time: number }
  ): void | Promise<void>
  merge(other: Handle<T>): void | Promise<void>
}

export type Session = {
  import(bytes: Uint8Array): Promise<{ url: string }>
  create<T>(initial: T): Promise<Handle<T>>
  /** Clones into this session; the source may belong to another session. */
  clone<T>(handle: Handle<T>): Promise<Handle<T>>
  find<T>(url: string): Promise<Handle<T>>
  flush(): Promise<void>
  close(): Promise<void>
}

export type Target = {
  id: string
  adapter: string
  open(database: string, stats?: StorageStats): Session
  /** The branch's own Automerge `splice`, for text edits inside `change`. */
  splice(
    doc: unknown,
    path: (string | number)[],
    index: number,
    remove: number,
    insert: string
  ): void
}
