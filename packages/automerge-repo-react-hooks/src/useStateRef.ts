import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from "react"

/**
 * Like `useState`, but also returns a ref whose `.current` is updated
 * synchronously inside the setter — so callbacks can read the latest value
 * without waiting for a re-render.
 *
 * @privateRemarks
 * Not idiomatic — a stale-closure workaround, inlined (ESM) to replace the
 * CommonJS `react-usestateref` dependency, which does not bundle cleanly for
 * ESM/browser consumers. Used only by the two `@deprecated` awareness hooks
 * (`useLocalAwareness`/`useRemoteAwareness`); the replacement `usePresence` hook
 * does not use it. Prefer eliminating it: rewrite those hooks to use functional
 * state updaters for read-modify-write updates, and a plain ref synced in an
 * effect (or `useEffectEvent`) for reads inside long-lived callbacks — then
 * delete this helper.
 */
export function useStateRef<S>(
  initialState: S | (() => S)
): [S, Dispatch<SetStateAction<S>>, MutableRefObject<S>] {
  const [state, setState] = useState(initialState)
  const ref = useRef(state)
  const dispatch = useCallback<Dispatch<SetStateAction<S>>>(setStateAction => {
    ref.current =
      typeof setStateAction === "function"
        ? (setStateAction as (prev: S) => S)(ref.current)
        : setStateAction
    setState(ref.current)
  }, [])
  return [state, dispatch, ref]
}

export default useStateRef
