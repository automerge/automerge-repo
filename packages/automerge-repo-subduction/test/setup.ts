import { vi } from "vitest"

// Records each node a backend builds, so tests can observe the dependency
// without reaching into backend internals.
vi.mock("@automerge/subduction/slim", async importOriginal => {
  const native =
    await importOriginal<typeof import("@automerge/subduction/slim")>()
  const { nodes, hex } = await import("./native.js")
  class Subduction extends native.Subduction {
    constructor(options: ConstructorParameters<typeof native.Subduction>[0]) {
      super(options)
      nodes.set(hex(options.signer.verifyingKey()), { node: this, options })
    }
  }
  return { ...native, Subduction }
})
