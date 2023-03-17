import { withTimeout } from "../../src/helpers/withTimeout"

export async function expectPromises(...promises: Promise<any>[]) {
  const timeout = 50
  return withTimeout(Promise.all(promises), timeout)
}
