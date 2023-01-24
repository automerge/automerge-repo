export type ChangeFn<T> = (d: T) => void
export type Change<T> = (cf: ChangeFn<T>) => void
