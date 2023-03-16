import assert from "assert"
import { pause } from "../../src/helpers/pause"

export async function expectPromises(...promises: Promise<any>[]) {
  const timeout = 50
  await Promise.race([
    Promise.all(promises),
    pause(timeout).then(() =>
      assert.fail(`expected promises did not all resolve in ${timeout} ms`)
    ),
  ])
}
