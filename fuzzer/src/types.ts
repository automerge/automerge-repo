import { DocHandle } from "@automerge/automerge-repo/slim"

export type PeerId = string & { __peerId: true }
export type DocumentId = string & { __documentId: true }

export interface NetworkConfig {
  peerId: PeerId
  peers: PeerId[]
  numDocuments: number
  numPeers: number
  latency: number
  messageLoss: number
  numOperations: number
  operationTypes: OperationType[]
}

export type OperationType =
  | "TEXT_INSERT"
  | "TEXT_DELETE"
  | "MAP_SET"
  | "LIST_INSERT"
  | "LIST_DELETE"

export interface Operation {
  type: OperationType
  peerId: PeerId
  documentId: DocumentId
  value?: any
  path?: string[]
}

export interface TestCase {
  name: string
  config: NetworkConfig
  operations: Operation[]
}

export interface FuzzerResult {
  success: boolean
  error?: string
  testCase: TestCase
}

export interface NetworkSimulator {
  send(message: Uint8Array, to: PeerId): void
  partition(peerId: PeerId): void
  reconnect(peerId: PeerId): void
}

export interface OperationGenerator {
  generate(peers: PeerId[], documents: DocumentId[]): Operation[]
}

export interface StateVerifier {
  verify(handles: DocHandle<any>[], testCase: TestCase): Promise<FuzzerResult>
}
