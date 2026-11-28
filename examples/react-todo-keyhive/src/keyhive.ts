/**
 * Console helpers for poking at keyhive from the web inspector (`kh.help()`).
 *
 * Each todo is its own document, so sharing the list document alone would
 * leave its items unreadable. Instead every list has a keyhive group: the list
 * and each of its todos grant the group, and sharing adds someone to it.
 */
import {
  parseAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
  type QueryState,
  type Repo,
} from "@automerge/react"
import type {
  KeyhiveBackend,
  KeyhiveExtensions,
} from "@automerge/automerge-repo-subduction-keyhive"
import {
  ContactCard,
  DocumentId,
  GroupId,
  Identifier,
  MemberedId,
  Power,
} from "@keyhive/keyhive/slim"
import type { State } from "./types.js"

type Handle<T> = DocHandle<T, KeyhiveExtensions>

const POWERS = ["read", "edit", "admin", "relay", "pull"] as const
type PowerName = (typeof POWERS)[number]

export class ConsoleKeyhive {
  /** Contact cards (base64) of the other tabs seen on the BroadcastChannel. */
  readonly peers: Record<string, string> = {}
  /** The list document. Set once it is open. */
  handle?: Handle<State>
  readonly #channel = new BroadcastChannel("automerge-repo-demo-todo-keyhive")
  #group?: GroupId

  readonly Power = Power
  readonly Identifier = Identifier
  readonly ContactCard = ContactCard
  readonly MemberedId = MemberedId

  constructor(
    readonly me: string,
    readonly backend: KeyhiveBackend,
    readonly repo: Repo<KeyhiveExtensions>
  ) {
    this.#channel.onmessage = ({ data }) => {
      if (!data?.name || data.name === this.me) return
      if (!(data.name in this.peers)) console.info(`[kh] found peer "${data.name}"`)
      this.peers[data.name] = data.card
      if (data.type === "hello") this.#announce("card")
    }
    this.discover()
  }

  /** Ask the other tabs (same browser profile and origin) for their cards. */
  discover(): void {
    this.#announce("hello")
  }

  /** This replica's keyhive. */
  get local() {
    return this.backend.keyhive()
  }

  /** This replica's keyhive ID, as hex. */
  get id(): string {
    return toHex(this.local.id.toBytes())
  }

  /** This replica's contact card, as base64. Paste it into another browser. */
  async card(): Promise<string> {
    const card = await this.local.getExistingContactCard()
    return toBase64(card.toBytes())
  }

  /**
   * Share the list with a peer, given a tab name from {@link peers} or a
   * base64 contact card.
   */
  async share(who: string, power: PowerName = "edit"): Promise<void> {
    const card = ContactCard.fromBytes(this.#cardBytes(who))
    const group = this.#groupId()
    if (group) {
      await this.local.receiveContactCard(card)
      await this.local.addMember(card.id, MemberedId.group(group), powerOf(power))
      return
    }
    // No group handle on this replica: grant each document directly instead.
    await this.shareDirect(who, power)
  }

  /**
   * Share the list and each of its current todos directly, without the group.
   * Todos created later are not covered.
   */
  async shareDirect(who: string, power: PowerName = "edit"): Promise<void> {
    const card = ContactCard.fromBytes(this.#cardBytes(who))
    for (const handle of await this.#docs()) {
      await handle.keyhive().addMemberFromContactCard(card, powerOf(power))
    }
  }

  /** Revoke a peer (tab name, base64 card or hex keyhive ID). */
  async revoke(who: string): Promise<void> {
    const id = this.#identifier(who)
    const group = this.#groupId()
    if (group) {
      await this.local.revokeMember(id, true, MemberedId.group(group))
    }
    for (const handle of await this.#docs()) {
      try {
        await handle.keyhive().revokeMember(id)
      } catch (error) {
        console.debug("not a direct member of", handle.url, error)
      }
    }
  }

  /** Who can reach a document (default: the list), as a table. */
  async members(handle: Handle<unknown> | undefined = this.handle) {
    const names = this.#namesById()
    const rows = (await this.#require(handle).keyhive().members()).map(m => {
      const raw = m as unknown as Record<string, any>
      const bytes: Uint8Array | undefined =
        raw.who?.toBytes?.() ?? raw.who?.id?.toBytes?.()
      const id = bytes ? toHex(bytes) : "?"
      return {
        name: names.get(id) ?? (id === this.id ? `${this.me} (me)` : ""),
        id,
        power: raw.can?.toString?.() ?? String(raw.can),
        raw: m,
      }
    })
    console.table(rows, ["name", "id", "power"])
    return rows
  }

  /** This replica's power on a document (default: the list). */
  async access(handle: Handle<unknown> | undefined = this.handle) {
    return (await this.#require(handle).keyhive().myAccess())?.toString()
  }

  /** Records received for a document that cannot be decrypted yet. */
  pending(handle: Handle<unknown> | undefined = this.handle): number {
    return this.#require(handle).keyhive().pendingCount
  }

  /**
   * For the list and each todo: applied changes, and records keyhive holds
   * back because they cannot be decrypted yet. Run it in the receiving
   * browser when an edit is missing.
   */
  async status() {
    const list = this.#require(this.handle)
    const urls = [list.url, ...(list.doc()?.todos ?? [])]
    const rows = urls.map((url, i) => {
      let state = { status: "loading" } as QueryState<unknown, KeyhiveExtensions>
      this.repo.query(url).subscribe(s => {
        state = s
      })()
      const handle = state.status === "ready" ? state.handle : undefined
      const doc = handle?.doc() as Partial<State & { content: string }> | undefined
      const id = toHex(parseAutomergeUrl(url).binaryDocumentId)
      return {
        doc: i === 0 ? "list" : `todo ${i}`,
        state: state.status,
        content: !doc
          ? ""
          : i === 0
            ? `${doc.todos?.length ?? 0} todos`
            : (doc.content ?? ""),
        changes: handle?.metrics().numChanges ?? 0,
        pending: this.backend.pendingCount(id as never),
        url,
      }
    })
    console.table(rows, ["doc", "state", "content", "changes", "pending"])
    return rows
  }

  /**
   * This replica's power on any document by URL, from its own keyhive. Works
   * for documents that are not open or are unavailable.
   */
  async accessTo(url: AutomergeUrl): Promise<string | undefined> {
    const doc = new DocumentId(parseAutomergeUrl(url).binaryDocumentId)
    const me = new Identifier(this.local.id.toBytes())
    return (await this.local.accessForDoc(me, doc))?.toString()
  }

  /** {@link accessTo} for the list and each todo. */
  async accessAll() {
    const list = this.#require(this.handle)
    const urls = [list.url, ...(list.doc()?.todos ?? [])]
    const rows = await Promise.all(
      urls.map(async (url, i) => ({
        doc: i === 0 ? "list" : `todo ${i}`,
        access: (await this.accessTo(url)) ?? "none",
      }))
    )
    console.table(rows)
    return rows
  }

  /** How many documents this replica can reach. */
  async reachable(): Promise<number> {
    return (await this.local.reachableDocs()).length
  }

  /** Run keyhive sync with peers now instead of waiting for the interval. */
  sync(): void {
    this.backend.syncKeyhive()
  }

  /** Create the list's group and grant it the list. */
  async initList(handle: Handle<State>): Promise<void> {
    const group = await this.local.generateGroup([])
    this.#group = group
    const id = group.toIdentifier()
    await handle.keyhive().addMember(id, Power.edit())
    handle.change(s => {
      s.keyhiveGroup = toHex(id.toBytes())
    })
  }

  /** Grant a new todo to the list's group. */
  async grantTodo(url: AutomergeUrl): Promise<void> {
    const hex = this.handle?.doc()?.keyhiveGroup
    if (!hex) return
    const todo = await this.repo.find(url)
    await todo.keyhive().addMember(new Identifier(fromHex(hex)), Power.edit())
  }

  help(): void {
    console.log(
      `%ckeyhive todo — you are "${this.me}"`,
      "font-weight: bold",
      `
  kh.peers                    other tabs' contact cards (open ?as=<name> in another tab)
  kh.discover()               ask other tabs for their cards again
  await kh.card()             my contact card (base64), for another browser
  await kh.share("bob")       add bob to this list's group (power: "edit" by default)
  await kh.share(card, "read")
  await kh.shareDirect("bob")   grant the list and current todos directly, not via the group
  await kh.revoke("bob")      revoke by tab name, card or hex ID
  await kh.members()          who can reach the list (pass a handle for a todo)
  await kh.access()           my power on the list
  kh.pending()                records waiting for keys
  await kh.status()           per document: applied changes and records waiting for keys
  await kh.accessAll()        per document: my power, according to my own keyhive
  await kh.reachable()        documents I can reach
  kh.sync()                   run keyhive sync now
  kh.handle, kh.backend, kh.local, kh.Power, kh.Identifier, kh.ContactCard`
    )
  }

  #announce(type: "hello" | "card"): void {
    this.card()
      .then(card => this.#channel.postMessage({ type, name: this.me, card }))
      .catch(error => console.warn("[kh] could not announce this tab", error))
  }

  /**
   * The list's group. Only known for certain on the replica that created it;
   * elsewhere it is rebuilt from the ID stored in the list, if keyhive's
   * `GroupId` accepts bytes.
   */
  #groupId(): GroupId | undefined {
    if (this.#group) return this.#group
    const hex = this.handle?.doc()?.keyhiveGroup
    if (!hex) return
    try {
      return (this.#group = new (GroupId as any)(fromHex(hex)))
    } catch {
      return undefined
    }
  }

  async #docs(): Promise<Handle<unknown>[]> {
    const list = this.#require(this.handle)
    const todos = await Promise.all(
      (list.doc()?.todos ?? []).map(url => this.repo.find(url))
    )
    return [list, ...todos]
  }

  #identifier(who: string): Identifier {
    if (/^[0-9a-f]{64}$/i.test(who)) return new Identifier(fromHex(who))
    return ContactCard.fromBytes(this.#cardBytes(who)).id
  }

  /** The card bytes of a peer, given its tab name or a base64 card. */
  #cardBytes(who: string): Uint8Array {
    const known = this.peers[who]
    if (known) return fromBase64(known)
    try {
      return fromBase64(who)
    } catch {
      throw new Error(
        `Unknown peer "${who}" (known: ${Object.keys(this.peers).join(", ") || "none"}). ` +
          `Run kh.discover(), or paste the card that tab prints with await kh.card().`
      )
    }
  }

  #namesById(): Map<string, string> {
    return new Map(
      Object.entries(this.peers).map(([name, card]) => [
        toHex(ContactCard.fromBytes(fromBase64(card)).id.toBytes()),
        name,
      ])
    )
  }

  #require<T>(handle: Handle<T> | undefined): Handle<T> {
    if (!handle) throw new Error("No document open yet")
    return handle
  }
}

function powerOf(name: PowerName): Power {
  const make = (Power as unknown as Record<string, unknown>)[name]
  if (!POWERS.includes(name) || typeof make !== "function") {
    throw new TypeError(`power must be one of ${POWERS.join(", ")}`)
  }
  return make.call(Power) as Power
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")
}

export function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], b => parseInt(b, 16))
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0))
}
