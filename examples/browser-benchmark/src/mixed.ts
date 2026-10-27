// Mixed-document workload shared by fixture generation and both harnesses.
// The manifest holds replay parameters, not document bytes: every target
// replays the same edits through its own Repo, so each branch stores documents
// with its own mechanisms. Repos pick random actor IDs, and Automerge orders
// conflicting concurrent edits by actor, so concurrent actors only ever edit
// their own fields. The final content is then actor-independent and can be
// verified by hash on every target.

export type Bucket = "small" | "medium" | "large" | "text"
export type Kind = "record" | "log" | "notes" | "text"

export type MixedPlanDoc = {
  index: number
  bucket: Bucket
  kind: Kind
  /** Requested size; `changes` in the manifest is what replay produced. */
  target: number
  /** 1 for a single-author history; otherwise authors including the primary. */
  actors: number
  /** Fork/merge rounds; 0 for a single-author history. */
  cycles: number
  seed: number
  /** Written by the last change; checked when a load resolves. */
  seal: string
}

export type MixedDoc = MixedPlanDoc & {
  changes: number
  /** SHA-256 of {@link canonicalJson} of the final document. */
  sha256: string
  jsonBytes: number
}

/** JSON with sorted keys: a document in memory keeps insertion order, a
 * reloaded one does not. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map(key => [key, item[key]])
        )
      : item
  )
}

export type MixedManifest = { version: 1; count: number; docs: MixedDoc[] }

export const mixedCounts = (smoke: boolean) => (smoke ? [50] : [100, 500, 1000])

/** Every block of 100 documents has this mix, so 100/500/1,000 prefixes match. */
const buckets: [Bucket, number, number, number][] = [
  ["small", 60, 10, 100],
  ["medium", 30, 100, 1000],
  ["large", 9, 1000, 5000],
  ["text", 1, 10000, 30000],
]

export function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function mixedPlan(count: number): MixedPlanDoc[] {
  if (!Number.isSafeInteger(count) || count < 1 || count % 100)
    throw new Error("Mixed document count must be a positive multiple of 100")
  const docs: MixedPlanDoc[] = []
  for (let block = 0; block < count / 100; block++) {
    const next = random(1000 + block)
    const order = buckets.flatMap(([bucket, share]) =>
      Array<Bucket>(share).fill(bucket)
    )
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    for (const bucket of order) {
      const index = docs.length
      const seed = Math.imul(index + 1, 0x9e3779b1) | 0
      const pick = random(seed)
      const [, , low, high] = buckets.find(([name]) => name === bucket)!
      const target = Math.round(
        Math.exp(Math.log(low) + pick() * (Math.log(high) - Math.log(low)))
      )
      const roll = pick()
      const kind: Kind =
        bucket === "text"
          ? "text"
          : roll < 0.4
            ? "record"
            : roll < 0.75
              ? "log"
              : "notes"
      const multi = pick() < 0.2
      docs.push({
        index,
        bucket,
        kind,
        target,
        actors: multi ? 2 + Math.floor(pick() * 3) : 1,
        cycles: multi ? 1 + Math.floor(pick() * 3) : 0,
        seed,
        seal: `seal-${index}`,
      })
    }
  }
  return docs
}

const words =
  "the quick brown fox jumps over a lazy dog while automerge keeps every edit in sync".split(
    " "
  )

type Doc = Record<string, any>
type Path = (string | number)[]

/** Operations a harness provides; each call is one Automerge change. */
export type ReplayApi<H> = {
  create(initial: Doc): Promise<H>
  change(handle: H, edit: (doc: Doc) => void): void
  /** A concurrent copy with its own actor, outside the measured store. */
  fork(handle: H): Promise<H>
  merge(into: H, from: H): void
  splice(
    doc: Doc,
    path: Path,
    index: number,
    remove: number,
    insert: string
  ): void
}

const at = (doc: Doc, path: Path) =>
  path.reduce<Doc>((value, key) => value[key], doc)

/** Edits one author makes to its own object (the root or its branch). */
function author(
  kind: Kind,
  next: () => number,
  path: Path,
  splice: ReplayApi<unknown>["splice"]
) {
  const pick = (n: number) => Math.floor(next() * n)
  const phrase = (n: number) =>
    Array.from({ length: n }, () => words[pick(words.length)]).join(" ")
  let entries = 0
  let length = 0
  let cursor = 0
  let step = 0
  const typing = (doc: Doc, burst: number) => {
    if (next() < 0.05) cursor = pick(length + 1)
    const remove = length > 0 && next() < 0.1
    let insert = ""
    let deleted = 0
    if (remove) {
      if (cursor === 0) cursor = length
      deleted = Math.min(cursor, 1 + pick(10))
    } else {
      const size = 1 + pick(burst)
      while (insert.length < size)
        insert += next() < 0.05 ? "\n" : `${words[pick(words.length)]} `
      insert = insert.slice(0, size)
    }
    const index = cursor - deleted
    splice(doc, [...path, "body"], index, deleted, insert)
    length += insert.length - deleted
    cursor = index + insert.length
  }
  return {
    initial(): Doc {
      if (kind === "record")
        return {
          count: 0,
          items: Array.from({ length: 32 }, (_, i) => `item-${i}`),
          tags: {},
        }
      if (kind === "log") return { entries: [] }
      return { body: "" }
    },
    edit(doc: Doc) {
      step++
      const target = at(doc, path)
      if (kind === "record") {
        target.count = step
        target.items[pick(32)] = `${words[pick(words.length)]}-${step}`
        if (next() < 0.1) target.tags[words[pick(words.length)]] = step
      } else if (kind === "log") {
        if (entries && next() < 0.15)
          target.entries[pick(entries)].note = phrase(1 + pick(6))
        else {
          target.entries.push({ at: step, note: phrase(1 + pick(6)) })
          entries++
        }
      } else {
        typing(doc, kind === "text" ? 20 : 8)
        if (kind === "notes" && next() < 0.03) target.title = phrase(3)
      }
    },
  }
}

/**
 * Replays one document, yielding at each save point. Primary edits arrive in
 * bursts; multi-author documents fork concurrent authors that edit their own
 * branch, then merge, like peers syncing. Returns the primary handle and the
 * number of changes made across all authors.
 */
export async function* replay<H>(
  doc: MixedPlanDoc,
  api: ReplayApi<H>
): AsyncGenerator<void, { handle: H; changes: number }> {
  const next = random(doc.seed ^ 0x5bd1e995)
  const pick = (n: number) => Math.floor(next() * n)
  const chunkMax = Math.min(400, Math.max(5, Math.ceil(doc.target / 15)))
  const primary = author(doc.kind, next, [], api.splice)
  const handle = await api.create({
    id: doc.index,
    kind: doc.kind,
    title: `Document ${doc.index}`,
    branches: {},
    ...primary.initial(),
  })
  let changes = 1
  const edit = (h: H, apply: (doc: Doc) => void, steps: number) => {
    for (let i = 0; i < steps; i++) {
      api.change(h, apply)
      changes++
    }
  }
  // Create and seal are changes too.
  const budget = Math.max(0, doc.target - 2)
  const bursts = function* (total: number) {
    while (total > 0) {
      const size = Math.min(total, 1 + pick(chunkMax))
      total -= size
      yield size
    }
  }
  if (doc.actors === 1) {
    for (const size of bursts(budget)) {
      edit(handle, d => primary.edit(d), size)
      yield
    }
  } else {
    const before = Math.floor(budget * 0.3)
    for (const size of bursts(before)) {
      edit(handle, d => primary.edit(d), size)
      yield
    }
    const share = Math.max(
      1,
      Math.floor((budget - before) / (doc.cycles * doc.actors))
    )
    const forks: {
      handle: H
      key: string
      author: ReturnType<typeof author>
    }[] = []
    for (let cycle = 0; cycle < doc.cycles; cycle++) {
      if (cycle === 0) {
        for (let k = 1; k < doc.actors; k++) {
          const key = `a${k}`
          forks.push({
            handle: await api.fork(handle),
            key,
            author: author(doc.kind, next, ["branches", key], api.splice),
          })
        }
      } else for (const fork of forks) api.merge(fork.handle, handle)
      const writers = [
        { handle, author: primary, remaining: share, created: true },
        ...forks.map(fork => ({
          ...fork,
          remaining: share,
          created: cycle > 0,
        })),
      ]
      while (writers.some(w => w.remaining > 0)) {
        for (const w of writers) {
          if (!w.remaining) continue
          const size = Math.min(w.remaining, 1 + pick(chunkMax))
          w.remaining -= size
          if (!w.created) {
            // First fork change creates its branch, then edits it.
            const fork = w as (typeof writers)[number] & { key: string }
            api.change(w.handle, d => {
              d.branches[fork.key] = w.author.initial()
              w.author.edit(d)
            })
            changes++
            w.created = true
            edit(w.handle, d => w.author.edit(d), size - 1)
          } else edit(w.handle, d => w.author.edit(d), size)
        }
        yield
      }
      for (const fork of forks) api.merge(handle, fork.handle)
      yield
    }
  }
  api.change(handle, d => {
    d.seal = doc.seal
  })
  changes++
  yield
  return { handle, changes }
}

/** Replays documents concurrently, calling `save` at each shared save point. */
export async function replayBatch<H>(
  docs: MixedPlanDoc[],
  api: ReplayApi<H>,
  save: () => Promise<void>
): Promise<{ handle: H; changes: number }[]> {
  const runs = docs.map(doc => replay(doc, api))
  const results: { handle: H; changes: number }[] = []
  let active = runs.map((_, i) => i)
  while (active.length) {
    const steps = await Promise.all(active.map(i => runs[i].next()))
    active = active.filter((i, j) => {
      const step = steps[j]
      if (step.done) results[i] = step.value
      return !step.done
    })
    await save()
  }
  return results
}

/** Per-bucket readiness for one load wave over the first `readyMs.length` docs. */
export function bucketSummary(readyMs: number[], docs: MixedPlanDoc[]) {
  const quantile = (values: number[], p: number) =>
    values[Math.ceil(p * values.length) - 1]
  return Object.fromEntries(
    buckets.flatMap(([bucket]) => {
      const values = readyMs
        .filter((_, i) => docs[i].bucket === bucket)
        .sort((a, b) => a - b)
      if (!values.length) return []
      return [
        [
          bucket,
          {
            count: values.length,
            p50Ms: quantile(values, 0.5),
            p95Ms: quantile(values, 0.95),
            maxMs: values.at(-1)!,
          },
        ],
      ]
    })
  ) as Partial<
    Record<
      Bucket,
      { count: number; p50Ms: number; p95Ms: number; maxMs: number }
    >
  >
}
