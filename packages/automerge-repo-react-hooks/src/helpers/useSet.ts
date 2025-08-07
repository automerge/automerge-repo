import { useEffect, useState } from "react"

export function useSet<T>(items: T[]): Set<T> {
  const [set, setSet] = useState<Set<T>>(() => {
    return new Set<T>(items)
  })
  useEffect(() => {
    const newSet = new Set(items)
    if (identical(set, newSet)) {
      return
    }
    setSet(newSet)
  }, [set, items])
  return set
}

function identical<T>(s1: Set<T>, s2: Set<T>) {
  return s1.size === s2.size && Array.from(s1).every(v => s2.has(v))
}
