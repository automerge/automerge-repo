import EventEmitter from "eventemitter3"
import { NetworkAdapter, NetworkAdapterEvents } from "../../src/network/Network"

export default class MockNetworkAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements NetworkAdapter
{
  connect(_: string) {}

  join(_: string) {}

  leave(_: string) {}
}
