import EventEmitter from "eventemitter3"
import {
  ChannelId,
  NetworkAdapter,
  NetworkAdapterEvents,
  PeerId,
} from "../../src/network/NetworkSubsystem"

export class DummyNetworkAdapter
  extends EventEmitter<NetworkAdapterEvents>
  implements NetworkAdapter
{
  sendMessage(
    peerId: PeerId,
    channelId: ChannelId,
    message: Uint8Array
  ): void {}
  connect(_: string) {}

  join(_: string) {}

  leave(_: string) {}
}
