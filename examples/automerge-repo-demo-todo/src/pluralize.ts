export const pluralize = (count: number, word: string) => {
  return count === 1 ? word : word + "s"
}
