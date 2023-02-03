export const localforageMock = (data: Record<string, Uint8Array>): LocalForageDbMethodsCore => {
  return ({
    clear(callback?: (err: any) => void): Promise<void> {
      return Promise.resolve(undefined)
    },
    getItem(key: string, callback?: (err: any, value: (any | null)) => void): Promise<any | null> {
      return Promise.resolve(data[key] || null)
    },
    iterate<U>(iteratee: (value: any, key: string, iterationNumber: number) => U, callback?: (err: any, result: U) => void): Promise<U> {
      return Promise.resolve(undefined)
    },
    key(keyIndex: number, callback?: (err: any, key: string) => void): Promise<string> {
      return Promise.resolve("")
    },
    keys(callback?: (err: any, keys: string[]) => void): Promise<string[]> {
      return Promise.resolve([])
    },
    length(callback?: (err: any, numberOfKeys: number) => void): Promise<number> {
      return Promise.resolve(0)
    },
    removeItem(key: string, callback?: (err: any) => void): Promise<void> {
      delete data[key]

      return Promise.resolve(undefined)
    },
    setItem(key: string, value: any, callback?: (err: any, value: any) => void): Promise<any> {
      data[key] = value

      return Promise.resolve(undefined)
    },
  })
};
