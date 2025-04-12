import {
  Operation,
  OperationType,
  PeerId,
  DocumentId,
  NetworkConfig,
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
