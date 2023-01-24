export const arraysAreEqual = <T>(a: T[], b: T[]) =>
  a.length === b.length && a.every((element, index) => element === b[index])
