import { AutomergeUrl, useDocHandle } from "@automerge/react"
import cx from "clsx"
import { useEffect, useState } from "react"

/**
 * A small "is this doc up to date with the sync server?" indicator, driven
 * by automerge-repo's remote-heads forwarding.
 *
 * It listens to the handle's `"remote-heads"` event — which the subduction
 * integration fires when a peer (here, the sync server) reports the heads it
 * has for this document — and compares those heads to this tab's local heads
 * (`handle.heads()`). Equal heads ⇒ "Synced"; different ⇒ "Syncing…".
 *
 * Because the last-known remote heads are persisted, the indicator also shows
 * the last sync state immediately on reload, before the network reconnects.
 *
 * Try it: open this URL in two tabs, edit in one, and watch the other's
 * indicator go yellow → green as the change propagates through the server.
 */

type RemoteInfo = { heads: readonly string[]; timestamp: number }

const sameHeads = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")

const relativeTime = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 5) return "just now"
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

const shortHead = (h: string) => h.slice(0, 12)
const fmtHeads = (heads: readonly string[]) =>
  heads.length ? heads.map(shortHead).join(", ") : "—"

export function SyncStatus({ url }: { url: AutomergeUrl }) {
  const handle = useDocHandle(url, { suspense: false })
  const [remotes, setRemotes] = useState<Record<string, RemoteInfo>>({})
  const [localHeads, setLocalHeads] = useState<readonly string[]>([])
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (!handle) return
    setLocalHeads(handle.heads())

    const onRemote = (p: {
      storageId: string
      heads: readonly string[]
      timestamp: number
    }) =>
      setRemotes(prev => ({
        ...prev,
        [p.storageId]: { heads: p.heads, timestamp: p.timestamp },
      }))
    const onHeads = () => setLocalHeads(handle.heads())

    handle.on("remote-heads", onRemote)
    handle.on("heads-changed", onHeads)
    return () => {
      handle.off("remote-heads", onRemote)
      handle.off("heads-changed", onHeads)
    }
  }, [handle])

  // Keep the relative timestamps fresh.
  useEffect(() => {
    const id = setInterval(() => forceTick(n => n + 1), 15_000)
    return () => clearInterval(id)
  }, [])

  const peers = Object.entries(remotes)
  const syncedWith = peers.filter(([, r]) => sameHeads(r.heads, localHeads))
  const lastSeen = peers.reduce((m, [, r]) => Math.max(m, r.timestamp), 0)

  let color = "bg-gray-400"
  let label = "Connecting…"
  if (!handle) {
    label = "Loading…"
  } else if (peers.length === 0) {
    label = "Connecting…"
  } else if (syncedWith.length > 0) {
    color = "bg-green-500"
    label = "Synced"
  } else {
    color = "bg-yellow-500"
    label = "Syncing…"
  }

  const tooltip = [
    `local: ${localHeads.join(", ") || "—"}`,
    ...peers.map(
      ([id, r]) =>
        `${id}: ${r.heads.join(", ") || "—"} (${
          sameHeads(r.heads, localHeads) ? "in sync" : "differs"
        }, ${relativeTime(r.timestamp)})`
    ),
  ].join("\n")

  return (
    <div className="flex flex-col items-end gap-0.5">
      <div
        className="flex items-center gap-1.5 text-xs text-gray-500"
        title={tooltip}
      >
        <span className={cx("inline-block w-2 h-2 rounded-full", color)} />
        <span>{label}</span>
        {peers.length > 0 && (
          <span className="text-gray-400">
            · {peers.length} peer{peers.length > 1 ? "s" : ""}
            {lastSeen > 0 ? ` · ${relativeTime(lastSeen)}` : ""}
          </span>
        )}
      </div>

      {/* local + remote heads hashes (truncated; full hashes in the tooltip) */}
      <div
        className="font-mono text-[10px] leading-tight text-gray-400 text-right"
        title={tooltip}
      >
        <div>
          <span className="text-gray-300">local</span> {fmtHeads(localHeads)}
        </div>
        {peers.map(([id, r]) => (
          <div key={id} className={cx(sameHeads(r.heads, localHeads) && "text-green-600")}>
            <span className="text-gray-300">{id.slice(0, 6)}…</span>{" "}
            {fmtHeads(r.heads)}
          </div>
        ))}
      </div>
    </div>
  )
}
