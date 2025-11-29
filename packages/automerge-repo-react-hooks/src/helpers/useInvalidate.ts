import { useCallback, useState } from "react"

export function useInvalidate() {
  const [, setState] = useState(0)
  const increment = useCallback(() => setState(value => value + 1), [setState])
  return increment
}
