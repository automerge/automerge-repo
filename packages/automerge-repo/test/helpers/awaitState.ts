import { DocumentProgress, QueryState } from "../../src/DocumentQuery.js"

export default async function awaitState(
  progress: DocumentProgress<unknown>,
  state: string
): Promise<void> {
  const current = progress.peek()
  if (current.state === state) {
    return
  }
  await new Promise(resolve => {
    const unsubscribe = progress.subscribe(s => {
      if (s.state === state) {
        unsubscribe()
        resolve(null)
      }
    })
  })
}
