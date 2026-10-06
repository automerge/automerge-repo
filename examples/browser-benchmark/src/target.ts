export type StorageStats = Record<
  "load" | "save" | "list" | "remove",
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
}

export type Session = {
  import(bytes: Uint8Array): Promise<{ url: string }>
  create<T>(initial: T): Promise<Handle<T>>
  find<T>(url: string): Promise<Handle<T>>
  flush(): Promise<void>
  close(): Promise<void>
}

export type Target = {
  id: string
  adapter: string
  open(database: string, stats?: StorageStats): Session
}
