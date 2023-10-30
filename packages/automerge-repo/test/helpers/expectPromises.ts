import { withTimeout } from "../../src/helpers/withTimeout.js"

export async function expectPromises(...promises: Promise<any>[]) {
  const timeout = 50
  return withTimeout(Promise.all(promises), timeout)
}
