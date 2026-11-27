import type {
  SubductionBackend,
  SubductionConnect,
  SubductionNetworkAdapterInterface,
} from "../src/index.js"
import { deferred } from "./storage.js"
import { PairedTransport } from "./transport.js"

const serviceName = "linked.test"

/** Dials `remote` in-process once `hold` resolves; no reconnection. */
export class LinkedAdapter implements SubductionNetworkAdapterInterface {
  readonly wires: PairedTransport[] = []
  #stopped = deferred()
  #isStopped = false
  constructor(
    private readonly remote?: SubductionBackend,
    private readonly hold?: Promise<void>
  ) {}
  async start(connect: SubductionConnect): Promise<void> {
    await Promise.race([this.hold, this.#stopped.promise])
    if (this.#isStopped) throw new Error("Adapter stopped")
    if (!this.remote) throw new Error("Remote unreachable")
    const [local, remote] = PairedTransport.pair()
    this.wires.push(local)
    void this.remote.acceptConnection(remote, { serviceName }).catch(() => {})
    await connect(local, { serviceName })
  }
  async stop(): Promise<void> {
    this.#isStopped = true
    this.#stopped.resolve()
    await Promise.all(this.wires.map(wire => wire.disconnect()))
  }
}
