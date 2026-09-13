import { Select as Base } from "@base-ui/react/select"
import type { ReactNode } from "react"
import { Icon } from "./icon"

export interface SelectProps<T> {
  placeholder?: string
  options: T[]
  /** Selected option (single selection). */
  current?: T
  value?: (x: T) => string
  label?: (x: T) => string
  onSelect?: (value: T | null) => void
  /** `base` matches the text inputs; `inline` is a compact settings-row trigger. */
  appearance?: "base" | "large" | "inline"
  invalid?: boolean
  disabled?: boolean
  className?: string
  children?: (item: T) => ReactNode
}

export function Select<T>(props: SelectProps<T>) {
  const label = (x: T) => (props.label ? props.label(x) : String(x))
  const render = (x: T) => (props.children ? props.children(x) : label(x))

  return (
    <Base.Root<T, false>
      value={props.current ?? null}
      onValueChange={(v) => props.onSelect?.(v)}
      disabled={props.disabled}
    >
      <Base.Trigger
        data-component="select"
        data-appearance={props.appearance ?? "base"}
        data-invalid={props.invalid ? "" : undefined}
        className={props.className}
      >
        <Base.Value data-slot="select-value">
          {(value: T | null) => (value == null ? props.placeholder : render(value))}
        </Base.Value>
        <Base.Icon data-slot="select-icon">
          <Icon name="chevron-down" size={16} />
        </Base.Icon>
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner data-slot="select-positioner">
          <Base.Popup data-slot="select-content">
            <Base.List data-slot="select-listbox">
              {props.options.map((opt) => (
                <Base.Item key={props.value ? props.value(opt) : label(opt)} value={opt} data-slot="select-item">
                  <Base.ItemText>{render(opt)}</Base.ItemText>
                  <Base.ItemIndicator data-slot="select-item-indicator">
                    <Icon name="circle-check" size={14} />
                  </Base.ItemIndicator>
                </Base.Item>
              ))}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
