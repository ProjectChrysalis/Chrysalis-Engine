import { useEffect, useState } from 'react'

export const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => setIsMobile(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isMobile
}

/** True on the same breakpoint from the other side — the desktop shell (icon
 *  rail + drawer navigation) lives at >=768px, the mobile one below it. */
export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT}px)`)
    const onChange = () => setIsDesktop(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return isDesktop
}
