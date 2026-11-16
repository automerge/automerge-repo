// Large-document workload shared by fixture generation and both harnesses.
// Documents are built from a seeded PRNG in fixed-size parts; one part is one
// change. Sizes are approximate MiB of encoded change bytes, or of the saved
// document for `basis: "saved"`, calibrated against Automerge 3.5.0 (actual
// sizes are recorded in the manifest).

// Same PRNG as mixed.ts; duplicated because Node loads this file directly and
// cannot resolve the browser's `.js` import specifiers to `.ts`.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * - `records`: rows of numbers, booleans and `ImmutableString`s. Decoding costs
 *   ~100 ms/MiB, within the 45-130 ms/MiB reported for real large documents.
 * - `json`: the same rows with plain strings, which Automerge 3 stores as text
 *   (one op per character): what `A.from(json)` produces.
 * - `text`: one long text field, the per-byte worst case.
 */
export type LargeShape = "records" | "json" | "text"
export const largeShapes: LargeShape[] = ["records", "json", "text"]

/** Rows (characters for `text`) per MiB of change bytes. */
const perMiB: Record<LargeShape, number> = {
  records: 8600,
  json: 5250,
  text: 1_050_000,
}
/** Rows (characters for `text`) per MiB of saved document. */
const perSavedMiB: Record<LargeShape, number> = {
  records: 21300,
  json: 12400,
  text: 1_750_000,
}

export type LargeApi = {
  ImmutableString: new (value: string) => unknown
  splice: (
    doc: unknown,
    path: (string | number)[],
    index: number,
    remove: number,
    insert: string
  ) => void
}

export type LargePlan = {
  shape: LargeShape
  mib: number
  /** What `mib` measures; encoded change bytes unless `saved`. */
  basis?: "changes" | "saved"
  /** Changes the content is split into. */
  parts: number
  seed: number
}

export type LargeFixture = LargePlan & {
  name: string
  sha256: string
  /** Saved document size. */
  bytes: number
  /** Total encoded change bytes. */
  changeBytes: number
  units: number
  last: string | null
}

export type LargeManifest = { version: 1; files: LargeFixture[] }

/** Fixture histories; `full` adds the slowest sizes. Text is ~5x slower per
 * byte than records, so it stays at 4 MiB. */
export function largePlans(full = true): LargePlan[] {
  const plans: LargePlan[] = [
    { shape: "records", mib: 8, parts: 64, seed: 8 },
    { shape: "records", mib: 32, parts: 64, seed: 32 },
    { shape: "json", mib: 8, parts: 64, seed: 108 },
    { shape: "text", mib: 4, parts: 64, seed: 204 },
  ]
  if (full)
    plans.push(
      { shape: "records", mib: 64, parts: 64, seed: 64 },
      { shape: "json", mib: 32, parts: 64, seed: 132 },
      // "32 MB" may mean a saved document: ~2.5x as many change bytes.
      { shape: "records", mib: 32, basis: "saved", parts: 64, seed: 332 },
      { shape: "records", mib: 64, basis: "saved", parts: 64, seed: 364 }
    )
  return plans
}

export const largeLabel = (plan: LargePlan) =>
  `${plan.shape}-${plan.basis === "saved" ? "saved-" : ""}${plan.mib}`

export const largeName = (plan: LargePlan) =>
  `large-${largeLabel(plan)}.automerge`

function word(next: () => number) {
  let w = ""
  const n = 3 + Math.floor(next() * 8)
  for (let i = 0; i < n; i++)
    w += String.fromCharCode(97 + Math.floor(next() * 26))
  return w
}

/** Total rows (characters for `text`) the plan produces. */
export function largeUnits(plan: LargePlan) {
  const rate = plan.basis === "saved" ? perSavedMiB : perMiB
  return Math.round(plan.mib * rate[plan.shape])
}

/** Initial content, before any part is applied. */
export function largeInitial(plan: LargePlan) {
  return plan.shape === "text" ? { text: "" } : { rows: [] }
}

/**
 * Returns one mutator per part, generated lazily so a 64 MiB document never
 * holds every row in JS at once. Apply each inside its own `change`.
 */
export function* largeParts(
  plan: LargePlan,
  api: LargeApi
): Generator<(doc: any) => void> {
  const next = random(plan.seed)
  const total = largeUnits(plan)
  let done = 0
  for (let part = 0; part < plan.parts; part++) {
    const size = Math.round((total * (part + 1)) / plan.parts) - done
    const start = done
    done += size
    if (plan.shape === "text") {
      let chunk = ""
      while (chunk.length < size) chunk += word(next) + " "
      chunk = chunk.slice(0, size)
      yield doc => api.splice(doc, ["text"], start, 0, chunk)
      continue
    }
    const string =
      plan.shape === "records"
        ? (value: string) => new api.ImmutableString(value)
        : (value: string) => value
    const rows = Array.from({ length: size }, (_, i) => ({
      id: start + i,
      name: string(`${word(next)} ${word(next)}`),
      email: string(`${word(next)}@${word(next)}.com`),
      active: next() < 0.5,
      score: Math.floor(next() * 1e6) / 100,
      tags: [string(word(next)), string(word(next))],
    }))
    // `push` reads the list length, which costs O(length) in Automerge 3.5.0,
    // so one call per row would be quadratic; batches keep argument lists
    // small. (Automerge 3.2.6 still overflows the stack applying the patch of
    // one change inserting more than ~120k items, whatever the batch size.)
    yield doc => {
      for (let i = 0; i < rows.length; i += 1000)
        doc.rows.push(...rows.slice(i, i + 1000))
    }
  }
}

/** Cheap content check after a reload: unit count plus the last unit. */
export function largeSummary(doc: any) {
  if (typeof doc?.text === "string")
    return { units: doc.text.length, last: doc.text.slice(-32) }
  const rows = doc?.rows
  if (!rows) return { units: 0, last: null }
  const last = rows[rows.length - 1]
  return {
    units: rows.length,
    last: last ? `${last.id}:${String(last.name)}:${last.score}` : null,
  }
}
