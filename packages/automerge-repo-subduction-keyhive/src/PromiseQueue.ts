/** Runs async tasks one at a time in the order they were submitted. */
export class PromiseQueue {
  #tail: Promise<void> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task)
    this.#tail = result.then(
      () => {},
      () => {}
    )
    return result
  }
}
