import { hash as sha256 } from "fast-sha256"
import {
  defineDocumentType,
  type DocumentType,
  type DocumentTypeContext,
} from "../../src/index.js"

export interface GCounterView {
  value: number
}

export interface GCounterTx {
  increment(amount?: number): void
}

export type GCounterChange = (tx: GCounterTx) => void

export interface GCounterInit {
  value?: number
}

interface GCounterCommit {
  actor: string
  seq: number
  amount: number
  parents: string[]
}

interface StoredGCounterCommit extends GCounterCommit {
  type: "g-counter/commit"
  version: 1
}

export interface GCounterState {
  actor: string
  seq: number
  commits: Map<string, GCounterCommit>
  heads: Set<string>
}

export type GCounterDocType = DocumentType<
  GCounterState,
  GCounterView,
  GCounterChange,
  GCounterInit | undefined
>

export function gCounterDocType(name = "counter"): GCounterDocType {
  return defineDocumentType<
    GCounterState,
    GCounterView,
    GCounterChange,
    GCounterInit | undefined
  >({
    name,
    empty: ctx => emptyCounterState(ctx),
    init: (init, ctx) => {
      const state = emptyCounterState(ctx)
      return addCounterCommit(state, init?.value ?? 0)
    },
    view: state => ({
      value: Array.from(state.commits.values()).reduce(
        (sum, commit) => sum + commit.amount,
        0
      ),
    }),
    change: (state, change) => {
      let amount = 0
      change({
        increment(delta = 1) {
          amount += delta
        },
      })
      if (amount === 0) return state
      return addCounterCommit(state, amount)
    },
    heads: state => Array.from(state.heads).sort(),
    hasData: state => state.heads.size > 0,
    viewAt: (state, heads) => viewCounterAt(state, heads),
    hasHeads: (state, heads) => heads.every(head => state.commits.has(head)),
    sedimentree: {
      metadata: state =>
        Array.from(state.commits.entries()).map(([head, commit]) => ({
          kind: "commit" as const,
          head,
          parents: commit.parents,
        })),
      materialize: (state, metas) =>
        metas.map(meta => {
          if (meta.kind !== "commit") {
            throw new Error("g-counter does not support fragments")
          }
          const commit = state.commits.get(meta.head)
          if (!commit) {
            throw new Error(`Unknown g-counter commit ${meta.head}`)
          }
          return {
            kind: "commit" as const,
            head: meta.head,
            parents: commit.parents,
            bytes: encodeCounterCommit(commit),
          }
        }),
      apply: (state, blobs) => {
        let next = cloneCounterState(state)
        let changed = false
        for (const blob of blobs) {
          const decoded = decodeCounterCommit(blob)
          const head = counterCommitHead(decoded)
          if (next.commits.has(head)) continue
          next.commits.set(head, decoded)
          changed = true
        }
        if (!changed) return state
        next.heads = computeCounterHeads(next.commits)
        next.seq = Math.max(
          next.seq,
          ...Array.from(next.commits.values())
            .filter(c => c.actor === next.actor)
            .map(c => c.seq)
        )
        return next
      },
      liveHashes: state => state.commits.keys(),
    },
  })
}

function emptyCounterState(ctx: DocumentTypeContext): GCounterState {
  return {
    actor: ctx.peerId,
    seq: 0,
    commits: new Map(),
    heads: new Set(),
  }
}

function addCounterCommit(state: GCounterState, amount: number): GCounterState {
  const next = cloneCounterState(state)
  const commit: GCounterCommit = {
    actor: next.actor,
    seq: next.seq + 1,
    amount,
    parents: Array.from(next.heads).sort(),
  }
  const head = counterCommitHead(commit)
  next.seq = commit.seq
  next.commits.set(head, commit)
  next.heads = computeCounterHeads(next.commits)
  return next
}

function cloneCounterState(state: GCounterState): GCounterState {
  return {
    actor: state.actor,
    seq: state.seq,
    commits: new Map(state.commits),
    heads: new Set(state.heads),
  }
}

function viewCounterAt(state: GCounterState, heads: string[]): GCounterState {
  if (heads.length === 0) {
    return { ...state, commits: new Map(), heads: new Set() }
  }

  const reachable = new Set<string>()
  const stack = [...heads]
  while (stack.length > 0) {
    const head = stack.pop()!
    if (reachable.has(head)) continue
    const commit = state.commits.get(head)
    if (!commit) continue
    reachable.add(head)
    stack.push(...commit.parents)
  }

  const commits = new Map<string, GCounterCommit>()
  for (const [head, commit] of state.commits) {
    if (reachable.has(head)) commits.set(head, commit)
  }
  return {
    ...state,
    commits,
    heads: new Set(heads.filter(head => commits.has(head))),
  }
}

function computeCounterHeads(
  commits: Map<string, GCounterCommit>
): Set<string> {
  const parents = new Set<string>()
  for (const commit of commits.values()) {
    for (const parent of commit.parents) parents.add(parent)
  }
  const heads = new Set<string>()
  for (const head of commits.keys()) {
    if (!parents.has(head)) heads.add(head)
  }
  return heads
}

function counterCommitHead(commit: GCounterCommit): string {
  return bytesToHex(sha256(encodeCounterCommit(commit)))
}

function encodeCounterCommit(commit: GCounterCommit): Uint8Array {
  const stored: StoredGCounterCommit = {
    type: "g-counter/commit",
    version: 1,
    actor: commit.actor,
    seq: commit.seq,
    amount: commit.amount,
    parents: [...commit.parents].sort(),
  }
  return new TextEncoder().encode(stableStringify(stored))
}

function decodeCounterCommit(bytes: Uint8Array): GCounterCommit {
  const decoded = JSON.parse(
    new TextDecoder().decode(bytes)
  ) as Partial<StoredGCounterCommit>
  if (
    decoded.type !== "g-counter/commit" ||
    decoded.version !== 1 ||
    typeof decoded.actor !== "string" ||
    typeof decoded.seq !== "number" ||
    typeof decoded.amount !== "number" ||
    !Array.isArray(decoded.parents) ||
    decoded.parents.some(p => typeof p !== "string")
  ) {
    throw new Error("Invalid g-counter commit")
  }
  return {
    actor: decoded.actor,
    seq: decoded.seq,
    amount: decoded.amount,
    parents: [...decoded.parents].sort(),
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
}
