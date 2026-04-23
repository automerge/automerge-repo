import { next as A } from "@automerge/automerge/slim"
import type { Prop } from "@automerge/automerge/slim"
import debug from "debug"
import { EventEmitter } from "eventemitter3"
import { assertEvent, assign, createActor, setup, waitFor } from "xstate"
import {
  decodeHeads,
  encodeHeads,
  stringifyAutomergeUrl,
} from "./AutomergeUrl.js"
import { encode } from "./helpers/cbor.js"
import { headsAreSame } from "./helpers/headsAreSame.js"
import { withTimeout } from "./helpers/withTimeout.js"
import type { AutomergeUrl, DocumentId, PeerId, UrlHeads } from "./types.js"
import { StorageId } from "./storage/types.js"
import { DocumentState } from "./DocumentState.js"
import {
  AbortError,
  AbortOptions,
  isAbortErrorLike,
} from "./helpers/abortable.js"
import { isCursorMarker, isPattern, isSegment } from "./refs/guards.js"
import { matchesPattern } from "./refs/utils.js"
import {
  applyScopedChange as applyScopedChangeOp,
  applyScopedRemove as applyScopedRemoveOp,
  getPropPath as getPropPathFromSegments,
  resolvePropPathAt,
  resolveSegmentProp,
  scopedValue as scopedValueOp,
  updatePropsFromRoot as updatePropsFromRootOp,
} from "./refs/sub-handle-ops.js"
import type {
  AnyPathInput,
  ChangeFn as RefChangeFn,
  CursorRange,
  InferRefType,
  PathInput,
  PathSegment,
  Pattern,
  Segment,
} from "./refs/types.js"
import { KIND } from "./refs/types.js"

/**
 * A DocHandle is a wrapper around a single Automerge document that lets us listen for changes and
 * notify the network and storage of new changes.
 *
 * @remarks
 * A `DocHandle` represents a document which is being managed by a {@link Repo}. You shouldn't ever
 * instantiate this yourself. To obtain `DocHandle` use {@link Repo.find} or {@link Repo.create}.
 *
 * To modify the underlying document use either {@link DocHandle.change} or
 * {@link DocHandle.changeAt}. These methods will notify the `Repo` that some change has occured and
 * the `Repo` will save any new changes to the attached {@link StorageAdapter} and send sync
 * messages to connected peers.
 *
 * ---
 *
 * Worklist: remaining `if (this.#root)` branching for the next refactor pass.
 * Each sub-handle-aware method on DocHandle falls into one of three buckets
 * today. They are _not_ bugs - they're a natural consequence of the fact that
 * a `DocHandle` represents both "the root document" and "a scoped view into
 * it". The registry refactor localised dispatch but did not attempt to
 * eliminate this branching; the follow-up DocumentState extraction (moving
 * the XState machine, `#doc`, `#fixedHeads`, and sync state off DocHandle)
 * will let us delete most of these branches mechanically.
 *
 *   Bucket 1 (pure delegation): `inState`, `state`, `whenReady`, `heads`,
 *     `metadata`, `getRemoteHeads`, `getSyncInfo`, `setSyncInfo`,
 *     `isReadOnly`, `broadcast`. Each body is `if (this.#root) return
 *     this.#root.<method>(args)`; once the underlying state-machine-owning
 *     fields live on DocumentState, these can redirect through the
 *     container with no special-casing.
 *
 *   Bucket 2 (scoped-vs-unscoped split): `view`, `diff`, `change`,
 *     `changeAt`, `merge` (partial). These genuinely do different things on
 *     root vs sub (re-scope, filter patches, delegate scoped mutations
 *     through `sub-handle-ops`). Candidates for per-method helper
 *     extraction if the split grows further.
 *
 *   Bucket 3 (root-only lifecycle no-ops): `update`, `doneLoading`,
 *     `unavailable`, `request`, `unload`, `reload`, `delete`. The Repo
 *     calls these on the root; sub-handles short-circuit. Cleanest fix is
 *     "don't expose them on the sub handle" (e.g. a distinct sub-handle
 *     interface), but that's a larger API change.
 */
export class DocHandle<T> extends EventEmitter<DocHandleEvents<T>> {
  #log: debug.Debugger

  /** The XState actor running our state machine. Undefined on sub-handles. */
  #machine: ReturnType<typeof createActor<any>> | undefined

  /** If set, this handle will only show the document at these heads (root handles only). */
  #fixedHeads?: UrlHeads

  /** The last known state of our document. */
  #prevDocState: T = A.init<T>()

  /** How long to wait before giving up on a document. (Note that a document will be marked
   * unavailable much sooner if all known peers respond that they don't have it.) */
  #timeoutDelay = 60_000

  /** A dictionary mapping each peer to the last known heads we have. */
  #syncInfoByStorageId: Record<StorageId, SyncInfo> = {}

  /**
   * Shared container for state that is logically owned by the root document
   * rather than by this individual handle instance. Every `DocHandle` holds a
   * direct reference: root handles own their `DocumentState`; sub-handles
   * share their root's `DocumentState` so that `this.#documentState.<field>`
   * reaches the same object regardless of whether `this` is a root or a sub.
   *
   * Initialised in the constructor.
   */
  #documentState!: DocumentState

  /**
   * If set, this handle is a sub-handle scoped to a location within a root document handle.
   * When undefined, this is a root handle that owns the underlying Automerge document.
   */
  #root?: DocHandle<any>

  /** Path segments for sub-handles; empty array for root handles. */
  #path: PathSegment[] = []

  /** Cursor range for text-range sub-handles. */
  #range?: CursorRange

  /** @hidden */
  constructor(
    public documentId: DocumentId,
    options: DocHandleOptions<T> = {}
  ) {
    super()

    if ("timeoutDelay" in options && options.timeoutDelay) {
      this.#timeoutDelay = options.timeoutDelay
    }

    if ("heads" in options) {
      this.#fixedHeads = options.heads
    }

    // Sub-handle initialization: bypass the state machine and delegate to root.
    // Root-wide event subscriptions are installed once on the root the first
    // time a sub-handle is created (see `#installRootDispatcher`), so we do
    // not attach any per-sub-handle listeners here.
    if ("root" in options && options.root) {
      this.#root = options.root
      // Share the root's DocumentState. Every sub-handle points at the same
      // container so any `this.#documentState.<x>` access behaves identically
      // on root and sub.
      this.#documentState = options.root.#documentState
      this.#log = debug(
        `automerge-repo:dochandle:${this.documentId.slice(0, 5)}:sub`
      )
      const rootDoc = options.root.isReady() ? options.root.doc() : undefined
      const { path, range } = this.#normalizePath(
        rootDoc as A.Doc<any>,
        (options.pathInputs ?? []) as AnyPathInput[]
      )
      this.#path = path
      this.#range = range
      return
    }

    this.#documentState = new DocumentState()

    const doc = A.init<T>()

    this.#log = debug(`automerge-repo:dochandle:${this.documentId.slice(0, 5)}`)

    const delay = this.#timeoutDelay
    const machine = setup({
      types: {
        context: {} as DocHandleContext<T>,
        events: {} as DocHandleEvent<T>,
      },
      actions: {
        /** Update the doc using the given callback and put the modified doc in context */
        onUpdate: assign(({ context, event }) => {
          const oldDoc = context.doc
          assertEvent(event, UPDATE)
          const { callback } = event.payload
          const doc = callback(oldDoc)
          return { doc }
        }),
        onDelete: assign(() => {
          this.emit("delete", { handle: this })
          return { doc: A.init() }
        }),
        onUnavailable: assign(() => {
          return { doc: A.init() }
        }),
        onUnload: assign(() => {
          return { doc: A.init() }
        }),
      },
    }).createMachine({
      /** @xstate-layout N4IgpgJg5mDOIC5QAoC2BDAxgCwJYDswBKAYgFUAFAEQEEAVAUQG0AGAXUVAAcB7WXAC64e+TiAAeiAOwAOAKwA6ACxSAzKqks1ATjlTdAGhABPRAFolAJksKN2y1KtKAbFLla5AX09G0WPISkVAwAMgyMrBxIILz8QiJikggAjCzOijKqLEqqybJyLizaRqYIFpbJtro5Uo7J2o5S3r4YOATECrgQADZgJADCAEoM9MzsYrGCwqLRSeoyCtra8pa5adquySXmDjY5ac7JljLJeepKzSB+bYGdPX0AYgCSAHJUkRN8UwmziM7HCgqyVcUnqcmScmcMm2ZV2yiyzkOx1OalUFx8V1aAQ63R46AgBCgJGGAEUyAwAMp0D7RSbxGagJKHFgKOSWJTJGRSCosCpKaEmRCqbQKU5yXINeTaer6LwY67YogKXH4wkkKgAeX6AH1hjQqABNGncL70xKIJQ5RY5BHOJag6wwpRyEWImQVeT1aWrVSXBXtJUqgn4Ik0ADqNCedG1L3CYY1gwA0saYqbpuaEG4pKLksKpFDgcsCjDhTnxTKpTLdH6sQGFOgAO7oKYhl5gAQNngAJwA1iRY3R40ndSNDSm6enfpm5BkWAVkvy7bpuTCKq7ndZnfVeSwuTX-HWu2AAI4AVzgQhD6q12rILxoADVIyEaAAhMLjtM-RmIE4LVSQi4nLLDIGzOCWwLKA0cgyLBoFWNy+43B0R5nheaqajqepjuMtJfgyEh-FoixqMCoKqOyhzgYKCDOq6UIeuCSxHOoSGKgop74OgABuzbdOgABGvTXlho5GrhJpxJOP4pLulT6KoMhpJY2hzsWNF0QobqMV6LG+pc+A8BAcBiP6gSfFJ36EQgKksksKxrHamwwmY7gLKB85QjBzoAWxdZdL0FnfARST8ooLC7qoTnWBU4pyC5ViVMKBQaHUDQuM4fm3EGhJBWaU7-CysEAUp3LpEpWw0WYRw2LmqzgqciIsCxWUdI2zaXlAbYdt2PZ5dJ1n5jY2iJY1ikOIcMJHCyUWHC62hRZkUVNPKta3Kh56wJ1-VWUyzhFc64JWJCtQNBBzhQW4cHwbsrVKpxPF8YJgV4ZZIWIKkiKiiNSkqZYWjzCWaQ5hFh0AcCuR3QoR74qUknBRmzholpv3OkpRQNNRpTzaKTWKbIWR5FDxm9AIkA7e9skUYCWayLILBZGoLkUSKbIyIdpxHPoyTeN4QA */

      // You can use the XState extension for VS Code to visualize this machine.
      // Or, you can see this static visualization (last updated April 2024): https://stately.ai/registry/editor/d7af9b58-c518-44f1-9c36-92a238b04a7a?machineId=91c387e7-0f01-42c9-a21d-293e9bf95bb7

      initial: "idle",
      context: { documentId, doc },
      on: {
        UPDATE: { actions: "onUpdate" },
        UNLOAD: ".unloaded",
        DELETE: ".deleted",
      },
      states: {
        idle: {
          on: {
            BEGIN: "loading",
          },
        },
        loading: {
          on: {
            REQUEST: "requesting",
            DOC_READY: "ready",
          },
          after: { [delay]: "unavailable" },
        },
        requesting: {
          on: {
            DOC_UNAVAILABLE: "unavailable",
            DOC_READY: "ready",
          },
          after: { [delay]: "unavailable" },
        },
        unavailable: {
          entry: "onUnavailable",
          on: { DOC_READY: "ready" },
        },
        ready: {},
        unloaded: {
          entry: "onUnload",
          on: {
            RELOAD: "loading",
          },
        },
        deleted: { entry: "onDelete", type: "final" },
      },
    })

    // Instantiate the state machine
    this.#machine = createActor(machine)

    // Listen for state transitions
    this.#machine.subscribe(state => {
      const before = this.#prevDocState
      const after = state.context.doc
      this.#log(`→ ${state.value} %o`, after)
      // if the document has changed, emit a change event
      this.#checkForChanges(before, after)
    })

    // Start the machine, and send a create or find event to get things going
    this.#machine.start()
    this.begin()
  }

  // PRIVATE

  /** Returns the current full document (root doc), regardless of state */
  get #doc(): A.Doc<any> {
    if (this.#root) {
      return this.#root.#doc
    }
    return this.#machine!.getSnapshot().context.doc as A.Doc<any>
  }

  /** Returns the docHandle's state (READY, etc.) */
  get #state(): HandleState {
    if (this.#root) {
      return this.#root.#state
    }
    return this.#machine!.getSnapshot().value as HandleState
  }

  /** True when this handle is a sub-handle scoped to a location within a root document. */
  get #isSubHandle(): boolean {
    return this.#root !== undefined
  }

  /** Expose #fixedHeads for use by sub-handles (through #effectiveFixedHeads). */
  get _fixedHeadsForRef(): UrlHeads | undefined {
    return this.#fixedHeads
  }

  /** The effective fixed heads for this handle (own or inherited from root). */
  get #effectiveFixedHeads(): UrlHeads | undefined {
    return this.#fixedHeads ?? this.#root?._fixedHeadsForRef
  }

  /**
   * Returns a promise that resolves when the docHandle is in one of the given states
   *
   * @param awaitStates - HandleState or HandleStates to wait for
   * @param signal - Optional AbortSignal to cancel the waiting operation
   */
  #statePromise(
    awaitStates: HandleState | HandleState[],
    options?: AbortOptions
  ) {
    const awaitStatesArray = Array.isArray(awaitStates)
      ? awaitStates
      : [awaitStates]
    return waitFor(
      this.#machine!,
      s => awaitStatesArray.some(state => s.matches(state)),
      // use a longer delay here so as not to race with other delays
      { timeout: this.#timeoutDelay * 2, ...options }
    )
  }

  /**
   * Update the document with whatever the result of callback is
   *
   * This is necessary instead of directly calling
   * `this.#machine.send({ type: UPDATE, payload: { callback } })` because we
   * want to catch any exceptions that the callback might throw, then rethrow
   * them after the state machine has processed the update.
   */
  #sendUpdate(callback: (doc: A.Doc<T>) => A.Doc<T>) {
    // This is kind of awkward. we have to pass the callback to xstate and wait for it to run it.
    // We're relying here on the fact that xstate runs everything synchronously, so by the time
    // `send` returns we know that the callback will have been run and so `thrownException`  will
    // be set if the callback threw an error.
    let thrownException: null | Error = null
    this.#machine!.send({
      type: UPDATE,
      payload: {
        callback: (doc: A.Doc<T>) => {
          try {
            return callback(doc)
          } catch (e) {
            thrownException = e as Error
            return doc
          }
        },
      },
    } as any)
    if (thrownException) {
      // If the callback threw an error, we throw it here so the caller can handle it
      throw thrownException
    }
  }

  /**
   * Called after state transitions. If the document has changed, emits a change event. If we just
   * received the document for the first time, signal that our request has been completed.
   */
  #checkForChanges(before: A.Doc<T>, after: A.Doc<T>) {
    const beforeHeads = A.getHeads(before)
    const afterHeads = A.getHeads(after)
    const docChanged = !headsAreSame(
      encodeHeads(afterHeads),
      encodeHeads(beforeHeads)
    )
    if (docChanged) {
      this.emit("heads-changed", { handle: this, doc: after })

      const patches = A.diff(after, beforeHeads, afterHeads)
      if (patches.length > 0) {
        this.emit("change", {
          handle: this,
          doc: after,
          patches,
          // TODO: pass along the source (load/change/network)
          patchInfo: { before, after, source: "change" },
        })
      }

      // If we didn't have the document yet, signal that we now do
      if (!this.isReady()) this.#machine!.send({ type: DOC_READY })
    }
    this.#prevDocState = after
  }

  // PUBLIC

  /** This handle's URL. For root handles this is `automerge:<docId>[#heads]`; for sub-handles
   * the URL includes the path segments and any fixed heads from the root view.
   */
  get url(): AutomergeUrl {
    const segments: Segment[] | undefined =
      this.#path.length > 0 || this.#range
        ? this.#range
          ? [...(this.#path as Segment[]), this.#range]
          : (this.#path as Segment[])
        : undefined
    return stringifyAutomergeUrl({
      documentId: this.documentId,
      heads: this.#effectiveFixedHeads,
      segments,
    })
  }

  /**
   * @returns true if the document is ready for accessing or changes.
   *
   * Note that for documents already stored locally this occurs before synchronization with any
   * peers. We do not currently have an equivalent `whenSynced()`.
   */
  isReady = () => this.inState(["ready"])

  /**
   * @returns true if the document has been unloaded.
   *
   * Unloaded documents are freed from memory but not removed from local storage. It's not currently
   * possible at runtime to reload an unloaded document.
   */
  isUnloaded = () => this.inState(["unloaded"])

  /**
   * @returns true if the document has been marked as deleted.
   *
   * Deleted documents are removed from local storage and the sync process. It's not currently
   * possible at runtime to undelete a document.
   */
  isDeleted = () => this.inState(["deleted"])

  /**
   * @returns true if the document is currently unavailable.
   *
   * This will be the case if the document is not found in storage and no peers have shared it with us.
   */
  isUnavailable = () => this.inState(["unavailable"])

  /**
   * @returns true if the handle is in one of the given states.
   */
  inState = (states: HandleState[]): boolean => {
    if (this.#root) return this.#root.inState(states)
    return states.some(s => this.#machine!.getSnapshot().matches(s))
  }

  /** @hidden */
  get state(): HandleState {
    if (this.#root) return this.#root.state
    return this.#machine!.getSnapshot().value as HandleState
  }

  /**
   * Returns promise that resolves when document is in one of the given states (default is 'ready' state)
   *
   * Use this to block until the document handle has finished loading. The async equivalent to
   * checking `inState()`.
   *
   * @param awaitStates - HandleState or HandleStates to wait for
   * @param signal - Optional AbortSignal to cancel the waiting operation
   * @returns a promise that resolves when the document is in one of the given states (if no states
   * are passed, when the document is ready)
   */
  async whenReady(
    awaitStates: HandleState[] = ["ready"],
    options?: AbortOptions
  ): Promise<void> {
    if (this.#root) {
      return this.#root.whenReady(awaitStates, options)
    }
    try {
      await withTimeout(
        this.#statePromise(awaitStates, options),
        this.#timeoutDelay
      )
    } catch (error) {
      if (isAbortErrorLike(error)) {
        throw new AbortError() //throw new error for stack trace
      }
      console.log(
        `error waiting for ${
          this.documentId
        } to be in one of states: ${awaitStates.join(", ")}`
      )
      throw error
    }
  }

  /**
   * Returns the current Automerge document.
   *
   * For both root handles and sub-handles this returns the *whole* underlying document
   * (at the sub-handle's pinned heads, if any). To get the value at a sub-handle's
   * path (i.e. scoped to its sub-tree), use {@link DocHandle.value}.
   *
   * @throws if the handle is not ready
   */
  doc(): A.Doc<any> {
    if (!this.isReady()) throw new Error("DocHandle is not ready")
    const heads = this.#effectiveFixedHeads
    const underlying = this.#doc
    return (heads ? A.view(underlying, decodeHeads(heads)) : underlying) as A.Doc<any>
  }

  /**
   * Returns the scoped value this handle points to. For a root handle this is identical
   * to {@link DocHandle.doc}. For a sub-handle, this returns the value at the handle's
   * path (or the substring within a cursor range). Returns `undefined` if the path
   * cannot be resolved.
   */
  value(): T | undefined {
    const doc = this.doc()
    if (this.#path.length === 0 && !this.#range) {
      return doc as T
    }
    return this.#scopedValue(doc) as T | undefined
  }

  /**
   *
   * @deprecated */
  docSync() {
    console.warn(
      "docSync is deprecated. Use doc() instead. This function will be removed as part of the 2.0 release."
    )
    return this.doc()
  }

  /**
   * Returns the current "heads" of the underlying document, akin to a git commit.
   * For sub-handles this returns the root document's heads — heads are a document-level
   * concept. To see heads where this sub-handle's path changed, use {@link history}.
   * @returns the current document's heads, or undefined if the document is not ready
   */
  heads(): UrlHeads {
    if (this.#root) {
      return this.#root.heads()
    }
    if (!this.isReady()) throw new Error("DocHandle is not ready")
    if (this.#fixedHeads) {
      return this.#fixedHeads
    }
    return encodeHeads(A.getHeads(this.#doc))
  }

  begin() {
    if (this.#root) return
    this.#machine!.send({ type: BEGIN })
  }

  /**
   * Returns an array of all past "heads" for the document in topological order.
   *
   * @remarks
   * A point-in-time in an automerge document is an *array* of heads since there may be
   * concurrent edits. This API just returns a topologically sorted history of all edits
   * so every previous entry will be (in some sense) before later ones, but the set of all possible
   * history views would be quite large under concurrency (every thing in each branch against each other).
   * There might be a clever way to think about this, but we haven't found it yet, so for now at least
   * we present a single traversable view which excludes concurrency.
   * @returns UrlHeads[] - The individual heads for every change in the document. Each item is a tagged string[1].
   */
  history(): UrlHeads[] | undefined {
    if (!this.isReady()) {
      return undefined
    }

    const topo = A.topoHistoryTraversal(this.#doc)

    if (this.#path.length === 0 && !this.#range) {
      return topo.map(h => encodeHeads([h])) as UrlHeads[]
    }

    // Correctness: for sub-handles whose path contains pattern (match)
    // segments, the resolved prop path can change over history. Resolving
    // once against current heads would misattribute patches across steps
    // where the pattern pointed to a different index (or didn't resolve at
    // all). Instead, resolve the symbolic path independently against each
    // historical snapshot - both "before" and "after", so patches that
    // create the target (only resolvable after) or destroy it (only
    // resolvable before) are both captured.
    const segments = this.#path
    const out: UrlHeads[] = []
    for (let i = 0; i < topo.length; i++) {
      const after = [topo[i]]
      const before = i === 0 ? [] : [topo[i - 1]]
      const patches = A.diff(this.#doc, before, after)

      const beforePath =
        before.length === 0
          ? undefined
          : resolvePropPathAt(
              A.view(this.#doc, before) as A.Doc<any>,
              segments
            )
      const afterPath = resolvePropPathAt(
        A.view(this.#doc, after) as A.Doc<any>,
        segments
      )
      if (!beforePath && !afterPath) continue

      const overlaps = patches.some(
        p =>
          (beforePath !== undefined && pathsOverlap(p.path, beforePath)) ||
          (afterPath !== undefined && pathsOverlap(p.path, afterPath))
      )
      if (overlaps) {
        out.push(encodeHeads([topo[i]]) as UrlHeads)
      }
    }
    return out
  }

  /**
   * Creates a fixed "view" of an automerge document at the given point in time represented
   * by the `heads` passed in. The return value is the same type as doc() and will return
   * undefined if the object hasn't finished loading.
   *
   * @remarks
   * Note that our Typescript types do not consider change over time and the current version
   * of Automerge doesn't check types at runtime, so if you go back to an old set of heads
   * that doesn't match the heads here, Typescript will not save you.
   *
   * @argument heads - The heads to view the document at. See history().
   * @returns DocHandle<T> at the time of `heads`
   */
  view(heads: UrlHeads): DocHandle<T> {
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is not ready. Check \`handle.isReady()\` before calling view().`
      )
    }

    // For sub-handles, delegate to the root's view and then re-scope to the same path.
    if (this.#root) {
      const rootView = this.#root.view(heads)
      const segs: AnyPathInput[] = this.#range
        ? [...this.#path, this.#range]
        : [...this.#path]
      return (rootView.ref as (...s: AnyPathInput[]) => DocHandle<T>)(...segs)
    }

    const cacheKey = JSON.stringify(heads)
    const cached = this.#documentState.viewCache.get(cacheKey)?.deref() as
      | DocHandle<T>
      | undefined
    if (cached) return cached
    // Dead WeakRef entries are pruned on the way out.
    if (this.#documentState.viewCache.has(cacheKey)) {
      this.#documentState.viewCache.delete(cacheKey)
    }

    const handle = new DocHandle<T>(this.documentId, {
      heads,
      timeoutDelay: this.#timeoutDelay,
    })
    handle.update(() => A.clone(this.#doc))
    handle.doneLoading()

    this.#documentState.viewCache.set(cacheKey, new WeakRef(handle))
    return handle
  }

  /**
   * Returns a set of Patch operations that will move a materialized document from one state to another
   * if applied.
   *
   * @remarks
   * We allow specifying either:
   * - Two sets of heads to compare directly
   * - A single set of heads to compare against our current heads
   * - Another DocHandle to compare against (which must share history with this document)
   *
   * @throws Error if the documents don't share history or if either document is not ready
   * @returns Automerge patches that go from one document state to the other
   */
  diff(first: UrlHeads | DocHandle<T>, second?: UrlHeads): A.Patch[] {
    if (this.#root) {
      // Compute the full diff on the root, then scope it to this sub-
      // handle's path. Correctness: resolve the symbolic path against
      // *both* endpoint snapshots so patches that create or destroy the
      // target (pattern resolves only before / only after) are included.
      const allPatches = this.#root.diff(first as any, second) as A.Patch[]
      if (this.#path.length === 0 && !this.#range) return allPatches

      const rootDoc = this.#root.doc()!
      let fromHeads: UrlHeads
      let toHeads: UrlHeads
      if (first instanceof DocHandle) {
        fromHeads = (this.#root.heads() || []) as UrlHeads
        toHeads = (first.heads() || []) as UrlHeads
      } else {
        fromHeads = second ? first : ((this.#root.heads() || []) as UrlHeads)
        toHeads = second ? second : first
      }
      const fromDoc = A.view(rootDoc, decodeHeads(fromHeads)) as A.Doc<any>
      const toDoc = A.view(rootDoc, decodeHeads(toHeads)) as A.Doc<any>
      const fromPath = resolvePropPathAt(fromDoc, this.#path)
      const toPath = resolvePropPathAt(toDoc, this.#path)
      if (!fromPath && !toPath) return []
      return allPatches.filter(
        p =>
          (fromPath !== undefined && pathsOverlap(p.path, fromPath)) ||
          (toPath !== undefined && pathsOverlap(p.path, toPath))
      )
    }
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is not ready. Check \`handle.isReady()\` before calling diff().`
      )
    }

    const doc = this.#doc
    if (!doc) throw new Error("Document not available")

    // If first argument is a DocHandle
    if (first instanceof DocHandle) {
      if (!first.isReady()) {
        throw new Error("Cannot diff against a handle that isn't ready")
      }
      const otherHeads = first.heads()
      if (!otherHeads) throw new Error("Other document's heads not available")

      // Create a temporary merged doc to verify shared history and compute diff
      const mergedDoc = A.merge(A.clone(doc), first.doc()!)
      // Use the merged doc to compute the diff
      return A.diff(
        mergedDoc,
        decodeHeads(this.heads()!),
        decodeHeads(otherHeads)
      )
    }

    // Otherwise treat as heads
    const from = second ? first : ((this.heads() || []) as UrlHeads)
    const to = second ? second : first
    return A.diff(doc, decodeHeads(from), decodeHeads(to))
  }

  /**
   * `metadata(head?)` allows you to look at the metadata for a change
   * this can be used to build history graphs to find commit messages and edit times.
   * this interface.
   *
   * @remarks
   * I'm really not convinced this is the right way to surface this information so
   * I'm leaving this API "hidden".
   *
   * @hidden
   */
  metadata(change?: string): A.DecodedChange | undefined {
    if (this.#root) return this.#root.metadata(change)
    if (!this.isReady()) {
      return undefined
    }

    if (!change) {
      change = this.heads()![0]
    }
    // we return undefined instead of null by convention in this API
    return (
      A.inspectChange(this.#doc, decodeHeads([change] as UrlHeads)[0]) ||
      undefined
    )
  }

  /**
   * `update` is called any time we have a new document state; could be
   * from a local change, a remote change, or a new document from storage.
   * Does not cause state changes.
   * @hidden
   */
  update(callback: (doc: A.Doc<T>) => A.Doc<T>) {
    if (this.#root) {
      throw new Error("update() can only be called on root handles")
    }
    this.#sendUpdate(callback)
  }

  /**
   * `doneLoading` is called by the repo after it decides it has all the changes
   * it's going to get during setup. This might mean it was created locally,
   * or that it was loaded from storage, or that it was received from a peer.
   */
  doneLoading() {
    if (this.#root) return
    this.#machine!.send({ type: DOC_READY })
  }

  /**
   * Called by the repo when a doc handle changes or we receive new remote heads.
   * @hidden
   */
  setSyncInfo(storageId: StorageId, syncInfo: SyncInfo): void {
    if (this.#root) {
      this.#root.setSyncInfo(storageId, syncInfo)
      return
    }
    this.#syncInfoByStorageId[storageId] = syncInfo
    this.emit("remote-heads", {
      storageId,
      heads: syncInfo.lastHeads,
      timestamp: syncInfo.lastSyncTimestamp,
    })
  }

  /** Returns the heads of the storageId.
   *
   * @deprecated Use getSyncInfo instead.
   */
  getRemoteHeads(storageId: StorageId): UrlHeads | undefined {
    if (this.#root) return this.#root.getRemoteHeads(storageId)
    return this.#syncInfoByStorageId[storageId]?.lastHeads
  }

  /** Returns the heads and the timestamp of the last update for the storageId. */
  getSyncInfo(storageId: StorageId): SyncInfo | undefined {
    if (this.#root) return this.#root.getSyncInfo(storageId)
    return this.#syncInfoByStorageId[storageId]
  }

  /**
   * All changes to an Automerge document should be made through this method.
   * Inside the callback, the document should be treated as mutable: all edits will be recorded
   * using a Proxy and translated into operations as part of a single recorded "change".
   *
   * Note that assignment via ES6 spread operators will result in *replacing* the object
   * instead of mutating it which will prevent clean merges. This may be what you want, but
   * `doc.foo = { ...doc.foo, bar: "baz" }` is not equivalent to `doc.foo.bar = "baz"`.
   *
   * Local changes will be stored (by the StorageSubsystem) and synchronized (by the
   * DocSynchronizer) to any peers you are sharing it with.
   *
   * @param callback - A function that takes the current document and mutates it.
   *
   */
  change(
    callback: A.ChangeFn<T> | T,
    options: A.ChangeOptions<T> = {}
  ): void {
    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is in ${this.state} and not ready. Check \`handle.isReady()\` before accessing the document.`
      )
    }

    if (this.isReadOnly()) {
      if (this.#isSubHandle) {
        throw new Error("Cannot change a Ref on a read-only handle")
      }
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads. Use clone() to create a new document from this state.`
      )
    }

    if (this.#isSubHandle || this.#range) {
      // Coerce direct value (shorthand) to a function form.
      const fn = (
        typeof callback === "function" ? callback : () => callback
      ) as RefChangeFn<T>
      this.#root!.change(
        ((doc: A.Doc<any>) => this.#applyScopedChange(doc, fn)) as A.ChangeFn<
          any
        >,
        options as A.ChangeOptions<any>
      )
      return
    }

    this.#sendUpdate(doc => A.change(doc, options, callback as A.ChangeFn<T>))
  }
  /**
   * Makes a change as if the document were at `heads`.
   *
   * @returns A set of heads representing the concurrent change that was made.
   */
  changeAt(
    heads: UrlHeads,
    callback: A.ChangeFn<T>,
    options: A.ChangeOptions<T> = {}
  ): UrlHeads | undefined {
    if (this.#root) {
      // For sub-handles, delegate the concurrent-change semantics to the root while
      // scoping the callback to this handle's path.
      return this.#root.changeAt(
        heads,
        ((doc: A.Doc<any>) =>
          this.#applyScopedChange(doc, callback as RefChangeFn<T>)) as A.ChangeFn<
          any
        >,
        options as A.ChangeOptions<any>
      )
    }

    if (!this.isReady()) {
      throw new Error(
        `DocHandle#${this.documentId} is not ready. Check \`handle.isReady()\` before accessing the document.`
      )
    }
    if (this.#fixedHeads) {
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads. Use clone() to create a new document from this state.`
      )
    }

    let resultHeads: UrlHeads | undefined = undefined
    this.#sendUpdate(doc => {
      const result = A.changeAt(doc, decodeHeads(heads), options, callback)
      resultHeads = result.newHeads ? encodeHeads(result.newHeads) : undefined
      return result.newDoc
    })

    // the callback above will always run before we get here, so this should always contain the new heads
    return resultHeads
  }

  /**
   * Check if the document can be change()ed. Currently, documents can be
   * edited unless we are viewing a particular point in time.
   *
   * @remarks It is technically possible to back-date changes using changeAt(),
   *          but we block it for usability reasons when viewing a particular point in time.
   *          To make changes in the past, use the primary document handle with no heads set.
   *
   * @returns boolean indicating whether changes are possible
   */
  isReadOnly(): boolean {
    if (this.#root) return this.#root.isReadOnly()
    return !!this.#fixedHeads
  }

  /**
   * Merges another document into this document. Any peers we are sharing changes with will be
   * notified of the changes resulting from the merge.
   *
   * @returns the merged document.
   *
   * @throws if either document is not ready or if `otherHandle` is unavailable.
   */
  merge(
    /** the handle of the document to merge into this one */
    otherHandle: DocHandle<T>
  ) {
    if (this.#root) {
      throw new Error(
        "merge() is only supported on root handles; merge through the root document handle instead."
      )
    }
    if (!this.isReady() || !otherHandle.isReady()) {
      throw new Error("Both handles must be ready to merge")
    }
    if (this.#fixedHeads) {
      throw new Error(
        `DocHandle#${this.documentId} is in view-only mode at specific heads. Use clone() to create a new document from this state.`
      )
    }
    const mergingDoc = otherHandle.doc()

    this.update(doc => {
      return A.merge(doc, mergingDoc)
    })
  }

  /**
   * Updates the internal state machine to mark the document unavailable.
   * @hidden
   */
  unavailable() {
    if (this.#root) return
    this.#machine!.send({ type: DOC_UNAVAILABLE })
  }

  /**
   * Called by the repo either when the document is not found in storage.
   * @hidden
   * */
  request() {
    if (this.#root) return
    if (this.#state === "loading") this.#machine!.send({ type: REQUEST })
  }

  /** Called by the repo to free memory used by the document. */
  unload() {
    if (this.#root) return
    this.#machine!.send({ type: UNLOAD })
  }

  /** Called by the repo to reuse an unloaded handle. */
  reload() {
    if (this.#root) return
    this.#machine!.send({ type: RELOAD })
  }

  /** Called by the repo when the document is deleted. */
  delete() {
    if (this.#root) return
    this.#machine!.send({ type: DELETE })
  }

  /**
   * Sends an arbitrary ephemeral message out to all reachable peers who would receive sync messages
   * from you. It has no guarantee of delivery, and is not persisted to the underlying automerge doc
   * in any way. Messages will have a sending PeerId but this is *not* a useful user identifier (a
   * user could have multiple tabs open and would appear as multiple PeerIds). Every message source
   * must have a unique PeerId.
   */
  broadcast(message: unknown): void {
    if (this.#root) {
      this.#root.broadcast(message)
      return
    }
    this.emit("ephemeral-message-outbound", {
      handle: this,
      data: new Uint8Array(encode(message)),
    })
  }

  metrics(): { numOps: number; numChanges: number } {
    return A.stats(this.#doc)
  }

  /**
   * The root handle for this sub-handle, or this handle itself if it is a root/view handle.
   * This is the "document owner" and is always the handle under which sub-handles are created.
   */
  get docHandle(): DocHandle<any> {
    return this.#root ?? this
  }

  /** The resolved path segments for this handle (empty for root handles). */
  get path(): PathSegment[] {
    return this.#path
  }

  /** The cursor range for this handle, if any. */
  get range(): CursorRange | undefined {
    return this.#range
  }

  /**
   * Returns `[startIndex, endIndex]` for the current cursor range, resolved against the
   * current text value, or `undefined` if this handle has no range.
   */
  rangePositions(): [number, number] | undefined {
    if (!this.#range) return undefined
    const heads = this.#effectiveFixedHeads
    const rootDoc = heads ? A.view(this.#doc, decodeHeads(heads)) : this.#doc
    const propPath = this.#getPropPath()
    if (!propPath) return undefined
    const textPath = propPath
    try {
      const start = A.getCursorPosition(
        rootDoc,
        textPath,
        this.#range.start as A.Cursor
      )
      const end = A.getCursorPosition(
        rootDoc,
        textPath,
        this.#range.end as A.Cursor
      )
      return [start, end]
    } catch {
      return undefined
    }
  }

  /**
   * Create a sub-handle scoped to a location inside this document.
   *
   * Returns the same instance for the same path, ensuring referential equality.
   *
   * @example
   * ```ts
   * const titleRef = handle.ref('todos', 0, 'title');
   * titleRef.doc(); // string | undefined
   *
   * const sameRef = handle.ref('todos', 0, 'title');
   * titleRef === sameRef; // true
   * ```
   */
  ref<TPath extends readonly PathInput[]>(
    ...segments: [...TPath]
  ): DocHandle<InferRefType<T, TPath>> {
    return this.#createSubHandle(segments) as DocHandle<
      InferRefType<T, TPath>
    >
  }

  /** Alias for {@link DocHandle.ref} for discoverability when working with sub-documents. */
  sub<TPath extends readonly PathInput[]>(
    ...segments: [...TPath]
  ): DocHandle<InferRefType<T, TPath>> {
    return this.ref(...segments)
  }

  /**
   * Create a read-only sub-handle at the given heads (time travel). Equivalent to
   * `this.view(heads).ref(...this.path)` but preserves path composition for callers.
   *
   * Accepts either `UrlHeads` (base58-encoded, as returned by `handle.heads()`) or raw
   * Automerge heads (hex strings, as returned by `Automerge.getHeads(doc)`).
   */
  viewAt(heads: UrlHeads | A.Heads): DocHandle<T> {
    const rootHandle = this.#root ?? this
    const urlHeads = normalizeToUrlHeads(heads)
    const rootView = rootHandle.view(urlHeads)
    if (this.#path.length === 0 && !this.#range) {
      return rootView as unknown as DocHandle<T>
    }
    const segs: AnyPathInput[] = this.#range
      ? [...this.#path, this.#range]
      : [...this.#path]
    return (rootView.ref as (...s: AnyPathInput[]) => DocHandle<T>)(...segs)
  }

  /** Removes the value at this sub-handle's path from the underlying document. */
  remove(): void {
    if (this.#path.length === 0 && !this.#range) {
      throw new Error("Cannot remove the root document")
    }
    if (this.isReadOnly()) {
      throw new Error("Cannot remove from a Ref on a read-only handle")
    }
    const rootHandle = this.#root ?? this
    rootHandle.change(((doc: A.Doc<any>) => this.#applyScopedRemove(doc)) as A.ChangeFn<any>)
  }

  /** True if the other handle has the same URL as this one. */
  equals(other: DocHandle<any>): boolean {
    return this.url === other.url
  }

  /**
   * True if this handle's path is a strict ancestor of `other`'s path, within the same
   * document and view (heads).
   */
  contains(other: DocHandle<any>): boolean {
    if (other === this) return false
    if (this.documentId !== other.documentId) return false
    const thisHeads = this.#effectiveFixedHeads
    const otherHeads = (other as any).#effectiveFixedHeads as
      | UrlHeads
      | undefined
    if ((thisHeads?.toString() ?? "") !== (otherHeads?.toString() ?? "")) {
      return false
    }
    const thisPath = this.path
    const otherPath = other.path
    if (thisPath.length >= otherPath.length) return false
    for (let i = 0; i < thisPath.length; i++) {
      if (!segmentEquals(thisPath[i], otherPath[i])) return false
    }
    return true
  }

  /** True if this handle is a strict descendant of `other`. */
  isChildOf(other: DocHandle<any>): boolean {
    return other.contains(this)
  }

  /**
   * True if this and `other` are both text-range handles on the same path whose ranges
   * overlap in the current document.
   */
  overlaps(other: DocHandle<any>): boolean {
    if (this.documentId !== other.documentId) return false
    if (!this.#range || !other.range) return false
    const thisPath = this.path
    const otherPath = other.path
    if (thisPath.length !== otherPath.length) return false
    for (let i = 0; i < thisPath.length; i++) {
      if (!segmentEquals(thisPath[i], otherPath[i])) return false
    }
    const thisPos = this.rangePositions()
    const otherPos = (other as DocHandle<any>).rangePositions?.()
    if (!thisPos || !otherPos) return false
    return thisPos[0] < otherPos[1] && otherPos[0] < thisPos[1]
  }

  /**
   * True if this and `other` describe the same logical location — same document, same
   * resolved path, same range, and same view.
   */
  isEquivalent(other: DocHandle<any>): boolean {
    return this.equals(other)
  }

  /**
   * Returns the handle's URL when coerced to a string (e.g. in template literals or
   * `String(handle)`). We intentionally do *not* override `valueOf`: doing so would
   * silently change `==`/`===`/`<`/`>` semantics on `DocHandle`, which is surprising
   * for an object type. Use `handle.url` or `handle.equals(other)` for comparisons.
   */
  toString(): string {
    return this.url
  }

  /**
   * Subscribe to changes that affect this handle's path. Fires when the patch affects
   * any descendant of this handle's path. Returns an unsubscribe function.
   */
  onChange(
    callback: (
      value: T | undefined,
      payload: DocHandleChangePayload<T>
    ) => void
  ): () => void {
    const listener = (payload: DocHandleChangePayload<T>) => {
      callback(this.value(), payload)
    }
    this.on("change", listener)
    return () => this.off("change", listener)
  }

  // ---------------- Internal sub-handle helpers ----------------

  /**
   * Create or retrieve a cached sub-handle at the given path inputs, relative to this handle.
   * Sub-handles are cached on the root (or view) handle so repeated calls return the same instance.
   */
  #createSubHandle(
    segments: readonly AnyPathInput[]
  ): DocHandle<any> {
    if (segments.length === 0 && !this.#range) {
      return this
    }

    // Compose path relative to root
    const rootHandle = this.#root ?? this
    const combined: AnyPathInput[] = this.#range
      ? [...inputsFromPath(this.#path), this.#range, ...segments]
      : [...inputsFromPath(this.#path), ...segments]

    const cacheKey = pathToCacheKey(combined)
    const existing = this.#documentState.refCache.get(cacheKey)?.deref()
    if (existing) return existing

    // Lazily attach the root's centralised event dispatcher the first time
    // any sub-handle is created. After that, new sub-handles simply join
    // the registry and receive events through its trie walk.
    this.#documentState.registry.attachTo(rootHandle)

    const newHandle = new DocHandle<any>(rootHandle.documentId, {
      root: rootHandle,
      pathInputs: combined,
      timeoutDelay: this.#timeoutDelay,
    } as DocHandleOptions<any>)
    this.#documentState.refCache.set(cacheKey, new WeakRef(newHandle))
    return newHandle
  }

  /**
   * Normalize a mix of path inputs into ({@link PathSegment}[], {@link CursorRange}?).
   * Attempts to resolve segments (key/index/pattern) against the current document so that
   * patterns are rewritten into stable index lookups for tracking.
   */
  #normalizePath(
    rootDoc: A.Doc<any> | undefined,
    inputs: AnyPathInput[]
  ): { path: PathSegment[]; range?: CursorRange } {
    const path: PathSegment[] = []
    let range: CursorRange | undefined
    let cursor: unknown = rootDoc

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]

      if (isCursorMarker(input)) {
        if (i !== inputs.length - 1) {
          throw new Error("cursor() must be the last segment")
        }
        if (typeof cursor !== "string") {
          throw new Error("cursor() can only be used on string values")
        }
        if (rootDoc) {
          const propPath = getPropPathFromSegments(path)
          if (propPath) {
            const startCursor = A.getCursor(rootDoc, propPath, input.start)
            const endCursor = A.getCursor(rootDoc, propPath, input.end)
            range = {
              [KIND]: "cursors",
              start: startCursor,
              end: endCursor,
            }
          }
        }
        break
      }

      if (isSegment(input)) {
        // If this is a cursor-range segment (from URL parsing), treat it as a range.
        if ((input as any)[KIND] === "cursors") {
          if (i !== inputs.length - 1) {
            throw new Error("cursor range must be the last path segment")
          }
          range = input as CursorRange
          break
        }
        const resolvedProp = resolveSegmentProp(cursor, input as PathSegment)
        const segment = { ...input, prop: resolvedProp } as PathSegment
        path.push(segment)
        cursor = resolveSegment(cursor, segment)
        continue
      }

      if (typeof input === "string") {
        path.push({ [KIND]: "key", key: input, prop: input })
        cursor = resolveSegment(cursor, path[path.length - 1])
        continue
      }

      if (typeof input === "number") {
        path.push({ [KIND]: "index", index: input, prop: input })
        cursor = resolveSegment(cursor, path[path.length - 1])
        continue
      }

      if (isPattern(input)) {
        const idx = Array.isArray(cursor)
          ? (cursor as unknown[]).findIndex(item =>
              matchesPattern(item, input as Pattern)
            )
          : -1
        path.push({
          [KIND]: "match",
          match: input as Pattern,
          prop: idx >= 0 ? idx : undefined,
        } as PathSegment)
        cursor = idx >= 0 ? (cursor as unknown[])[idx] : undefined
        continue
      }

      throw new Error(`Unsupported path input: ${String(input)}`)
    }

    return { path, range }
  }

  /** The resolved numeric/string prop path for use with Automerge APIs. */
  #getPropPath(): Prop[] | undefined {
    return getPropPathFromSegments(this.#path)
  }

  /** Get the current scoped value (value at #path, or substring for a range handle). */
  #scopedValue(rootView: A.Doc<any>): unknown {
    return scopedValueOp(
      rootView,
      this.#path,
      this.#range,
      () => this.rangePositions()
    )
  }

  /** Apply a scoped change callback to a mutable view of the document. */
  #applyScopedChange(doc: A.Doc<any>, fn: RefChangeFn<any>): A.Doc<any> {
    return applyScopedChangeOp(
      doc,
      this.#path,
      this.#range,
      () => this.rangePositions(),
      fn
    )
  }

  /** Remove the value at this handle's path from the mutable document proxy. */
  #applyScopedRemove(doc: A.Doc<any>): A.Doc<any> {
    return applyScopedRemoveOp(
      doc,
      this.#path,
      this.#range,
      () => this.rangePositions()
    )
  }

  // ---------------- Listener retention (sub-handles only) ----------------
  //
  // Sub-handles are held on the shared DocumentState as `WeakRef`s (see
  // `DocumentState.refCache`), so they
  // can be garbage-collected whenever no one else references them. That's
  // usually what we want — but users who call
  // `handle.ref(...).on("change", cb)` without keeping a local variable for
  // the sub-handle would see their listener silently stop firing as soon as
  // the sub-handle was collected. To prevent that, the root keeps a strong
  // reference to any sub-handle that currently has ≥1 listener attached, and
  // drops it as soon as the last listener is removed.
  //
  // We implement this by overriding every EventEmitter method that can
  // change the listener count and re-checking `eventNames().length` after.
  // `emit` is overridden too so that `once()` handlers, which auto-remove
  // themselves after firing, are accounted for without needing an explicit
  // off() call.

  /**
   * Sub-handle only: sync our root-retainer status with whether we currently
   * have any listeners attached. Cheap enough to call from every listener
   * mutation (and from every emit, to catch `once` auto-removal).
   */
  #updateSubHandleRetention(): void {
    if (!this.#root) return
    const registry = this.#documentState.registry
    if (this.eventNames().length > 0) {
      registry.insert(this)
    } else {
      registry.remove(this)
    }
  }

  on<E extends EventEmitter.EventNames<DocHandleEvents<T>>>(
    event: E,
    fn: EventEmitter.EventListener<DocHandleEvents<T>, E>,
    context?: any
  ): this {
    super.on(event, fn, context)
    this.#updateSubHandleRetention()
    return this
  }

  addListener<E extends EventEmitter.EventNames<DocHandleEvents<T>>>(
    event: E,
    fn: EventEmitter.EventListener<DocHandleEvents<T>, E>,
    context?: any
  ): this {
    super.addListener(event, fn, context)
    this.#updateSubHandleRetention()
    return this
  }

  once<E extends EventEmitter.EventNames<DocHandleEvents<T>>>(
    event: E,
    fn: EventEmitter.EventListener<DocHandleEvents<T>, E>,
    context?: any
  ): this {
    super.once(event, fn, context)
    this.#updateSubHandleRetention()
    return this
  }

  off<E extends EventEmitter.EventNames<DocHandleEvents<T>>>(
    event: E,
    fn?: EventEmitter.EventListener<DocHandleEvents<T>, E>,
    context?: any,
    once?: boolean
  ): this {
    super.off(event, fn, context, once)
    this.#updateSubHandleRetention()
    return this
  }

  removeListener<E extends EventEmitter.EventNames<DocHandleEvents<T>>>(
    event: E,
    fn?: EventEmitter.EventListener<DocHandleEvents<T>, E>,
    context?: any,
    once?: boolean
  ): this {
    super.removeListener(event, fn, context, once)
    this.#updateSubHandleRetention()
    return this
  }

  removeAllListeners(
    event?: EventEmitter.EventNames<DocHandleEvents<T>>
  ): this {
    super.removeAllListeners(event)
    this.#updateSubHandleRetention()
    return this
  }

  emit<E extends EventEmitter.EventNames<DocHandleEvents<T>>>(
    event: E,
    ...args: EventEmitter.EventArgs<DocHandleEvents<T>, E>
  ): boolean {
    const result = super.emit(event, ...args)
    // `once` listeners auto-remove themselves during emit; re-check so the
    // root can release its strong grip if that was our last listener.
    this.#updateSubHandleRetention()
    return result
  }

  // ---------------- Sub-handle dispatch hooks (invoked from root) ---------------
  // These are internal to DocHandle.ts. They exist because the root dispatcher
  // lives on one DocHandle instance but needs to fan out events into every live
  // sub-handle instance. Using explicit methods (rather than subscribing N
  // listeners on the root) keeps both the per-event and per-sub-handle cost to
  // a single predictable pass through `DocumentState.refCache`.

  /** @internal Logger accessor used by the root dispatcher. */
  get _log(): debug.Debugger {
    return this.#log
  }

  /**
   * @internal Number of sub-handles this root currently retains because they
   * have at least one listener attached. Used by tests.
   */
  get _subHandleRetainerSize(): number {
    return this.#documentState.subHandleRetainers.size
  }

  /** @internal The sub-handle's symbolic path segments. Empty for root handles. */
  get _pathSegments(): readonly PathSegment[] {
    return this.#path
  }

  /**
   * @internal Resolved numeric/string prop path at the current document state,
   * or `undefined` if any segment fails to resolve (e.g. a pattern has no
   * matching item). Used by the registry to key the literal trie and to
   * filter patches on pattern-path sub-handles.
   */
  _propPath(): Prop[] | undefined {
    return this.#getPropPath()
  }

  /**
   * @internal Emit a pre-filtered `change` event directly on this sub-handle,
   * skipping the re-resolve + filter pass that `_dispatchRootChange` does.
   * Called by the registry for literal-path sub-handles once the trie walk
   * has computed which patches concern this sub-handle.
   */
  _emitFilteredChange(
    payload: DocHandleChangePayload<any>,
    filtered: A.Patch[]
  ): void {
    if (filtered.length === 0) return
    this.emit("change", {
      handle: this as unknown as DocHandle<T>,
      doc: payload.doc,
      patches: filtered,
      patchInfo: payload.patchInfo,
    })
  }

  /** @internal Forward a root `change` event, filtered to this sub-handle's path. */
  _dispatchRootChange(payload: DocHandleChangePayload<any>): void {
    // Keep segment props (indices resolved from patterns, etc.) fresh.
    this.#updatePropsFromRoot()
    const propPath = this.#getPropPath()
    if (!propPath) return
    const filtered = payload.patches.filter(p =>
      pathsOverlap(p.path, propPath)
    )
    if (filtered.length === 0) return
    // `doc` on the sub-handle payload is the full root doc (see
    // `DocHandleChangePayload.doc`). We forward the root payload's `doc`
    // directly rather than the scoped `value()` so both root and sub
    // subscribers see the same document snapshot.
    this.emit("change", {
      handle: this as unknown as DocHandle<T>,
      doc: payload.doc,
      patches: filtered,
      patchInfo: payload.patchInfo,
    })
  }

  /** @internal Forward a root `heads-changed` event. */
  _dispatchRootHeadsChanged(
    payload: DocHandleEncodedChangePayload<any>
  ): void {
    this.emit("heads-changed", {
      handle: this as unknown as DocHandle<T>,
      doc: payload.doc,
    })
  }

  /** @internal Forward a root `delete` event. */
  _dispatchRootDelete(): void {
    this.emit("delete", { handle: this as unknown as DocHandle<T> })
  }

  /** @internal Forward a root `remote-heads` event (payload is already document-level). */
  _dispatchRootRemoteHeads(payload: DocHandleRemoteHeadsPayload): void {
    this.emit("remote-heads", payload)
  }

  /** @internal Forward a root `ephemeral-message` event with this sub-handle as the handle. */
  _dispatchRootEphemeralMessage(
    payload: DocHandleEphemeralMessagePayload<any>
  ): void {
    this.emit("ephemeral-message", {
      ...payload,
      handle: this as unknown as DocHandle<T>,
    })
  }

  /** Re-resolve the `prop` on each path segment against the current document state. */
  #updatePropsFromRoot() {
    const rootDoc = this.#root?.isReady() ? this.#root.doc() : undefined
    updatePropsFromRootOp(rootDoc, this.#path, resolveSegmentProp)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (module-private)
// ---------------------------------------------------------------------------

function pathToCacheKey(segments: readonly AnyPathInput[]): string {
  return segments
    .map(seg => {
      if (typeof seg === "string") return `s:${seg}`
      if (typeof seg === "number") return `n:${seg}`
      if (typeof seg === "object" && seg !== null) {
        if (isSegment(seg)) return `seg:${JSON.stringify(seg)}`
        return `o:${JSON.stringify(seg)}`
      }
      return `?:${String(seg)}`
    })
    .join("/")
}

function inputsFromPath(path: readonly PathSegment[]): AnyPathInput[] {
  return path.map(s => s as AnyPathInput)
}

function segmentEquals(a: PathSegment, b: PathSegment): boolean {
  return (a as any).prop === (b as any).prop
}

function resolveSegment(cursor: unknown, segment: PathSegment): unknown {
  if (cursor == null) return undefined
  const prop = (segment as any).prop
  if (prop === undefined) return undefined
  return (cursor as any)[prop]
}

function pathsOverlap(a: readonly Prop[], b: readonly Prop[]): boolean {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

//  TYPES

export type SyncInfo = {
  lastHeads: UrlHeads
  lastSyncTimestamp: number
}

/** @hidden */
export type DocHandleOptions<T> =
  // NEW DOCUMENTS
  | {
      /** If we know this is a new document (because we're creating it) this should be set to true. */
      isNew: true

      /** The initial value of the document. */
      initialValue?: T
    }
  // EXISTING DOCUMENTS
  | {
      isNew?: false

      // An optional point in time to lock the document to.
      heads?: UrlHeads

      /** The number of milliseconds before we mark this document as unavailable if we don't have it and nobody shares it with us. */
      timeoutDelay?: number

      /** @hidden — internal: when set, constructs this handle as a sub-handle of `root`. */
      root?: DocHandle<any>

      /** @hidden — internal: path inputs for the sub-handle. */
      pathInputs?: AnyPathInput[]
    }

// EXTERNAL EVENTS

/** These are the events that this DocHandle emits to external listeners */
export interface DocHandleEvents<T> {
  "heads-changed": (payload: DocHandleEncodedChangePayload<T>) => void
  change: (payload: DocHandleChangePayload<T>) => void
  delete: (payload: DocHandleDeletePayload<T>) => void
  "ephemeral-message": (payload: DocHandleEphemeralMessagePayload<T>) => void
  "ephemeral-message-outbound": (
    payload: DocHandleOutboundEphemeralMessagePayload<T>
  ) => void
  "remote-heads": (payload: DocHandleRemoteHeadsPayload) => void
}

/** Emitted when this document's heads have changed */
export interface DocHandleEncodedChangePayload<T> {
  handle: DocHandle<T>
  /**
   * The full root Automerge document after the change.
   *
   * Note: even on sub-handles (`DocHandle<SubT>` where `SubT` is the scoped
   * value type) this is the whole root document, not the scoped value. The
   * type is `A.Doc<any>` rather than `A.Doc<T>` so we don't lie about that
   * on sub-handles; if you want the scoped value, use `handle.value()`.
   */
  doc: A.Doc<any>
}

/** Emitted when this document has changed */
export interface DocHandleChangePayload<T> {
  /** The handle that changed. For sub-handles, this is the sub-handle itself. */
  handle: DocHandle<T>
  /**
   * The full root Automerge document after the change.
   *
   * Note: even on sub-handles (`DocHandle<SubT>` where `SubT` is the scoped
   * value type) this is the whole root document, not the scoped value — use
   * `handle.value()` (or the first argument to `handle.onChange`) for the
   * scoped value.
   */
  doc: A.Doc<any>
  /**
   * The patches representing the change that occurred. On sub-handles, these
   * are filtered to patches whose path overlaps the sub-handle's path.
   */
  patches: A.Patch[]
  /**
   * Information about the change, carrying `before`/`after` snapshots of the
   * whole root document.
   */
  patchInfo: A.PatchInfo<any>
}

/** Emitted when this document is deleted */
export interface DocHandleDeletePayload<T> {
  handle: DocHandle<T>
}

/** Emitted when this document has been marked unavailable */
export interface DocHandleUnavailablePayload<T> {
  handle: DocHandle<T>
}

/** Emitted when an ephemeral message is received for the document */
export interface DocHandleEphemeralMessagePayload<T> {
  handle: DocHandle<T>
  senderId: PeerId
  message: unknown
}

/** Emitted when an ephemeral message is sent for this document */
export interface DocHandleOutboundEphemeralMessagePayload<T> {
  handle: DocHandle<T>
  data: Uint8Array
}

/** Emitted when we have new remote heads for this document */
export interface DocHandleRemoteHeadsPayload {
  storageId: StorageId
  heads: UrlHeads
  timestamp: number
}

// STATE MACHINE TYPES & CONSTANTS

// state

/**
 * Possible internal states for a DocHandle
 */
export const HandleState = {
  /** The handle has been created but not yet loaded or requested */
  IDLE: "idle",
  /** We are waiting for storage to finish loading */
  LOADING: "loading",
  /** We are waiting for someone in the network to respond to a sync request */
  REQUESTING: "requesting",
  /** The document is available */
  READY: "ready",
  /** The document has been unloaded from the handle, to free memory usage */
  UNLOADED: "unloaded",
  /** The document has been deleted from the repo */
  DELETED: "deleted",
  /** The document was not available in storage or from any connected peers */
  UNAVAILABLE: "unavailable",
} as const
export type HandleState = (typeof HandleState)[keyof typeof HandleState]

export const {
  IDLE,
  LOADING,
  REQUESTING,
  READY,
  UNLOADED,
  DELETED,
  UNAVAILABLE,
} = HandleState

// context

interface DocHandleContext<T> {
  documentId: DocumentId
  doc: A.Doc<T>
}

// events

/** These are the (internal) events that can be sent to the state machine */
type DocHandleEvent<T> =
  | { type: typeof BEGIN }
  | { type: typeof REQUEST }
  | { type: typeof DOC_READY }
  | {
      type: typeof UPDATE
      payload: { callback: (doc: A.Doc<T>) => A.Doc<T> }
    }
  | { type: typeof UNLOAD }
  | { type: typeof RELOAD }
  | { type: typeof DELETE }
  | { type: typeof TIMEOUT }
  | { type: typeof DOC_UNAVAILABLE }

/**
 * Accept either base58-encoded `UrlHeads` or raw hex-string Automerge `Heads` and return
 * the `UrlHeads` form. Raw heads produced by `Automerge.getHeads(doc)` are hex strings,
 * so we detect that by checking whether every element parses as hex.
 */
function normalizeToUrlHeads(heads: UrlHeads | A.Heads): UrlHeads {
  if (heads.length === 0) return heads as UrlHeads
  const isHex = heads.every(
    h => typeof h === "string" && /^[0-9a-fA-F]+$/.test(h)
  )
  return (isHex ? encodeHeads(heads as A.Heads) : heads) as UrlHeads
}

const BEGIN = "BEGIN"
const REQUEST = "REQUEST"
const DOC_READY = "DOC_READY"
const UPDATE = "UPDATE"
const UNLOAD = "UNLOAD"
const RELOAD = "RELOAD"
const DELETE = "DELETE"
const TIMEOUT = "TIMEOUT"
const DOC_UNAVAILABLE = "DOC_UNAVAILABLE"
