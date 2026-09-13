import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** Join class names, letting a later utility win over an earlier one of the
 * same kind so a call site can override a component's own defaults. */
export const cn = (...parts: ClassValue[]) => twMerge(clsx(parts))
