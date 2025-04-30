import {
  Operation,
  OperationType,
  PeerId,
  DocumentId,
  NetworkConfig,
  Doc,
} from "./types.js"

// Define a union type for all possible value types
type PrimitiveValueType = string | number | boolean | null

export class OperationGenerator {
  private random = Math.random
  private paths = {
    text: ["text"],
    list: ["list"],
    map: ["map"],
  }
  private config: NetworkConfig

  constructor(config: NetworkConfig) {
    this.config = config
  }

  generate(peers: PeerId[], documents: DocumentId[]): Operation[] {
    const operations: Operation[] = []
    const numOperations = this.config.numOperations

    for (let i = 0; i < numOperations; i++) {
      const peerId = peers[Math.floor(this.random() * peers.length)]
      const documentId = documents[Math.floor(this.random() * documents.length)]
      const operationType = this.getRandomOperationType()

      const operation: Operation = {
        type: operationType,
        peerId,
        documentId,
      }

      // Add path and value based on operation type
      switch (operationType) {
        case "TEXT_INSERT":
          operation.path = [...this.paths.text]
          operation.path.push("0") // Always insert at the start for simplicity
          operation.value = this.generateRandomValue()
          break
        case "TEXT_DELETE":
          operation.path = [...this.paths.text]
          operation.path.push("0") // Always delete from the start for simplicity
          break
        case "LIST_INSERT":
          operation.path = [...this.paths.list]
          operation.value = this.generateRandomValue()
          operation.path.push("0") // Always insert at the start for simplicity
          break
        case "LIST_DELETE":
          operation.path = [...this.paths.list]
          operation.path.push("0") // Always delete from the start for simplicity
          break
        case "MAP_SET":
          operation.path = [...this.paths.map]
          operation.value = this.generateRandomValue()
          break
      }

      operations.push(operation)
    }

    return operations
  }

  private getRandomOperationType(): OperationType {
    return this.config.operationTypes[
      Math.floor(this.random() * this.config.operationTypes.length)
    ]
  }

  private generateRandomValue(): PrimitiveValueType {
    const types = ["string", "number", "boolean", "null"]
    const type = types[Math.floor(this.random() * types.length)]

    switch (type) {
      case "string":
        return Math.random().toString(36).substring(7)
      case "number":
        return Math.floor(this.random() * 100)
      case "boolean":
        return this.random() > 0.5
      case "null":
        return null
      default:
        throw new Error(`Unknown type: ${type}`)
    }
  }
}

// Generate a single random operation
export function generateRandomOperation(): Operation {
  const operationTypes: OperationType[] = [
    "TEXT_INSERT",
    "TEXT_DELETE",
    "LIST_INSERT",
    "LIST_DELETE",
    "MAP_SET",
  ]
  const type = operationTypes[Math.floor(Math.random() * operationTypes.length)]
  const operation: Operation = {
    type,
    peerId: "test-peer",
    documentId: "test-doc",
  }

  // Add path and value based on operation type
  switch (type) {
    case "TEXT_INSERT":
      operation.path = ["text"]
      operation.path.push("0") // Always insert at the start for simplicity
      operation.value = generateRandomValue()
      break
    case "TEXT_DELETE":
      operation.path = ["text"]
      operation.path.push("0") // Always delete from the start for simplicity
      break
    case "LIST_INSERT":
      operation.path = ["list"]
      operation.value = generateRandomValue()
      operation.path.push("0") // Always insert at the start for simplicity
      break
    case "LIST_DELETE":
      operation.path = ["list"]
      operation.path.push("0") // Always delete from the start for simplicity
      break
    case "MAP_SET":
      operation.path = ["map"]
      operation.value = generateRandomValue()
      break
  }

  return operation
}

// Apply a single operation to a document
export function applyOperation(doc: Doc, operation: Operation): void {
  const index = Number(operation.path![operation.path!.length - 1])

  switch (operation.type) {
    case "TEXT_INSERT":
      if (!doc.text) doc.text = ""
      if (index <= doc.text.length) {
        doc.text =
          doc.text.slice(0, index) + operation.value + doc.text.slice(index)
      }
      break
    case "TEXT_DELETE":
      if (!doc.text) doc.text = ""
      if (index < doc.text.length) {
        doc.text = doc.text.slice(0, index) + doc.text.slice(index + 1)
      }
      break
    case "LIST_INSERT":
      if (!doc.list) doc.list = []
      if (index <= doc.list.length) {
        doc.list.splice(index, 0, operation.value)
      }
      break
    case "LIST_DELETE":
      if (!doc.list) doc.list = []
      if (index < doc.list.length) {
        doc.list.splice(index, 1)
      }
      break
    case "MAP_SET":
      if (!doc.map) doc.map = {}
      doc.map[operation.path![operation.path!.length - 1]] = operation.value
      break
  }
}

// Helper function to generate random values
function generateRandomValue(): PrimitiveValueType {
  const types = ["string", "number", "boolean", "null"]
  const type = types[Math.floor(Math.random() * types.length)]

  switch (type) {
    case "string":
      return Math.random().toString(36).substring(7)
    case "number":
      return Math.floor(Math.random() * 100)
    case "boolean":
      return Math.random() > 0.5
    case "null":
      return null
    default:
      throw new Error(`Unknown type: ${type}`)
  }
}
