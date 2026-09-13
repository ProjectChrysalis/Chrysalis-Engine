import type { ComponentPropsWithoutRef } from "react"

/** Text that sweeps a highlight across itself while something is pending.
 * Takes `text` or children, whichever the call site finds convenient. */
export function TextShimmer({ className, children, text, ...rest }: ComponentPropsWithoutRef<"span"> & { text?: string }) {
  return (
    <span data-component="text-shimmer" className={className} {...rest}>
      {text ?? children}
    </span>
  )
}
