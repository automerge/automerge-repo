export async function waitFor(callback: () => void) {
  let sleepMs = 10
  while (true) {
    try {
      callback()
      break
    } catch (e) {
      sleepMs *= 2
      await new Promise(resolve => {
        setTimeout(resolve, sleepMs)
      })
    }
  }
}
