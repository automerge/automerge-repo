type Status = "pending" | "success" | "error"

export type PromiseWrapper<T> = {
  promise: Promise<T>
  read(): T
}

export function wrapPromise<T>(promise: Promise<T>): PromiseWrapper<T> {
  let status: Status = "pending"
  let result: T
  let error: Error

  const suspender = promise.then(
    data => {
      status = "success"
      result = data
    },
    err => {
      status = "error"
      error = err
    }
  )

  return {
    promise,
    read(): T {
      switch (status) {
        case "pending":
          throw suspender
        case "error":
          throw error
        case "success":
          return result
      }
    },
  }
}
