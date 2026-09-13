import type { ComponentProps, ReactNode } from "react"
import { cn } from "./cn"
import { Icon, type IconName } from "./icon"

type Variant = "neutral" | "primary" | "danger" | "warning" | "outline" | "contrast" | "ghost" | "ghost-muted" | "loading"
type Size = "small" | "normal" | "large"

export interface ButtonProps extends ComponentProps<"button"> {
  size?: Size
  variant?: Variant
  icon?: IconName
}

export function Button({ variant, size, icon, className, children, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      data-component="button"
      data-size={size ?? "normal"}
      data-variant={variant ?? "neutral"}
      className={cn(className)}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === "small" ? 14 : 16} /> : null}
      {children}
    </button>
  )
}

export interface IconButtonProps extends Omit<ComponentProps<"button">, "children"> {
  icon?: ReactNode
  size?: Size
  variant?: "neutral" | "contrast" | "ghost" | "ghost-muted"
  state?: "rest" | "hover" | "pressed"
}

export function IconButton({ variant, size, state, icon, className, type, ...rest }: IconButtonProps) {
  return (
    <button
      type={type ?? "button"}
      data-component="icon-button"
      data-size={size ?? "normal"}
      data-variant={variant ?? "neutral"}
      data-state={state}
      className={cn(className)}
      {...rest}
    >
      {icon}
    </button>
  )
}
