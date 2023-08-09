import {type InboundMessagePayload} from "@automerge/automerge-repo"
import {ProtocolVersion} from "./protocolVersion"

export interface InboundWebSocketMessage extends InboundMessagePayload {
  supportedProtocolVersions?: ProtocolVersion[]
}

export interface OutboundWebSocketMessage extends InboundMessagePayload {
  errorMessage?: string
}
