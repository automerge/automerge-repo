import React from "react"
import { render } from "@testing-library/react"
import "@testing-library/jest-dom"

import { describe, expect, it, vi } from "vitest"
import { useSet } from "../../src/helpers/useSet"

describe("useSet", () => {
  const Component = ({
    args,
    onSet,
  }: {
    args: number[]
    onSet: (result: Set<number>) => void
  }) => {
    const result = useSet(args)
    onSet(result)
    return null
  }

  it("builds a Set from the provided arguments", () => {
    const onSet = vi.fn<(result: Set<number>) => void>()

    const source = [1, 2, 3]

    render(<Component args={source} onSet={onSet} />)

    const result = onSet.mock.lastCall?.at(0)
    expect(result?.size).toBe(source.length)
    source.forEach(entry => {
      expect(result?.has(entry)).toBe(true)
    })
  })

  it("collapses duplicates", () => {
    const onSet = vi.fn<(result: Set<number>) => void>()

    const source = [1, 2, 2, 3]

    render(<Component args={source} onSet={onSet} />)

    const result = onSet.mock.lastCall?.at(0)
    expect(result?.size).toBe(3)
    source.forEach(entry => {
      expect(result?.has(entry)).toBe(true)
    })
  })

  it("returns a new Set if the items change", () => {
    const onSet1 = vi.fn<(result: Set<number>) => void>()
    const source1 = [1, 2, 3]

    const { rerender } = render(<Component args={source1} onSet={onSet1} />)
    const result1 = onSet1.mock.lastCall?.at(0)

    const onSet2 = vi.fn<(result: Set<number>) => void>()
    const source2 = [2, 3, 4]
    rerender(<Component args={source2} onSet={onSet2} />)
    const result2 = onSet2.mock.lastCall?.at(0)

    expect(result1).not.toBe(result2)
    expect(result2?.size).toBe(source2.length)
    source2.forEach(entry => {
      expect(result2?.has(entry)).toBe(true)
    })
  })

  it("returns the same Set (same object by reference) if the items did not change", () => {
    const onSet1 = vi.fn<(result: Set<number>) => void>()
    const source1 = [1, 2, 3]

    const { rerender } = render(<Component args={source1} onSet={onSet1} />)
    const result1 = onSet1.mock.lastCall?.at(0)

    const onSet2 = vi.fn<(result: Set<number>) => void>()
    const source2 = [1, 2, 3]
    rerender(<Component args={source2} onSet={onSet2} />)
    const result2 = onSet2.mock.lastCall?.at(0)

    expect(result1).toBe(result2)
  })
})
