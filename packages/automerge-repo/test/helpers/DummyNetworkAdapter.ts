import EventEmitter from "eventemitter3"
import { NetworkAdapter, NetworkAdapterEvents } from "../../src"

export class DummyNetworkAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements NetworkAdapter
{
  sendMessage() {}
  connect(_: string) {}
  join(_: string) {}
  leave(_: string) {}
}
