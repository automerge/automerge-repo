import { DocHandle } from "@automerge/automerge-repo/slim"
import {
  StateVerifier as StateVerifierInterface,
  TestCase,
  FuzzerResult,
} from "./types.js"
import { diff } from "deep-object-diff"

export class StateVerifier implements StateVerifierInterface {
  async verify(
    handles: DocHandle<any>[],
    testCase: TestCase
  ): Promise<FuzzerResult> {
    try {
      // Wait for all handles to be ready
      await Promise.all(handles.map(handle => handle.isReady()))

      // Get the current state of all documents
      const states = await Promise.all(handles.map(handle => handle.doc()))

      // Verify that all documents have the same state
      const firstState = states[0]
      for (let i = 1; i < states.length; i++) {
        const differences = diff(states[i], firstState)
        if (Object.keys(differences).length > 0) {
          return {
            success: false,
            error: `Document states differ between peers. Differences:\n${JSON.stringify(
              differences,
              null,
              2
            )}\n\nDocument states:\nPeer 0: ${JSON.stringify(
              firstState,
              null,
              2
            )}\nPeer ${i}: ${JSON.stringify(states[i], null, 2)}`,
            testCase,
          }
        }
      }

      return {
        success: true,
        testCase,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        testCase,
      }
    }
  }
}
