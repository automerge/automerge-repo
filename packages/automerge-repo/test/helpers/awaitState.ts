import { FindProgress } from "../../src/FindProgress.js"
import { FindProgressWithMethods } from "../../src/Repo.js"

export default async function awaitState(
  progress: FindProgress<unknown> | FindProgressWithMethods<unknown>,
  state: string
): Promise<void> {
  if (progress.state == state) {
    return
  }
  if (!("subscribe" in progress)) {
    throw new Error(
      `expected progress in state ${state} but was in final state ${progress.state}`
    )
  }
  await new Promise(resolve => {
    const unsubscribe = progress.subscribe(progress => {
      if (progress.state === state) {
        unsubscribe()
        resolve(null)
      }
    })
  })
}
