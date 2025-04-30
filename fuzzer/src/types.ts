import { DocHandle } from "@automerge/automerge-repo/slim"

export type Doc = {
  text?: string
  list?: any[]
  map?: Record<string, any>
}

export type OperationType =
  | "TEXT_INSERT"
  | "TEXT_DELETE"
  | "LIST_INSERT"
  | "LIST_DELETE"
  | "MAP_SET"

export type Operation = {
  type: OperationType
  peerId: PeerId
  documentId: DocumentId
  path?: string[]
  value?: any
}

export type PeerId = string
export type DocumentId = string

export type NetworkConfig = {
  peerId: PeerId
  peers: PeerId[]
  numDocuments: number
  numOperations: number
  operationTypes: OperationType[]
  numPeers: number
  latency: number
  messageLoss: number
}

export interface FuzzerResult {
  success: boolean
  error?: string
  operations: number
  time: number
}

export interface TestCase {
  name: string
  description: string
  setup: () => Promise<void>
  verify: (handles: DocHandle<any>[]) => Promise<FuzzerResult>
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
