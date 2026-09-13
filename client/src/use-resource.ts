import { useCallback, useEffect, useRef, useState, type DependencyList } from "react"

export interface Resource<T> {
  /** undefined until the first load settles. */
  data: T | undefined
  loading: boolean
  /** Run the fetcher again, e.g. after a write; resolves when it settles. */
  refetch: () => Promise<void>
  /** Set the value without a round trip, for a response we already hold. */
  mutate: (value: T | undefined) => void
}

/** Fetch-on-mount with a manual refetch, re-running whenever `deps` change.
 * Responses that land after a newer request are dropped, so a fast second
 * fetch can never be overwritten by a slow first one. */
export function useResource<T>(fetcher: () => Promise<T>, deps: DependencyList = []): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const alive = useRef(true)

  // eslint-disable-next-line react-hooks/exhaustive-deps -- the call site names its own sources
  const run = useCallback(() => {
    const ticket = ++seq.current
    setLoading(true)
    return fetcher()
      .then((value) => {
        if (!alive.current || ticket !== seq.current) return
        setData(value)
        setLoading(false)
      })
      .catch(() => {
        if (!alive.current || ticket !== seq.current) return
        setLoading(false)
      })
  }, deps)

  useEffect(() => {
    alive.current = true
    void run()
    return () => {
      alive.current = false
    }
  }, [run])

  return { data, loading, refetch: run, mutate: setData }
}
