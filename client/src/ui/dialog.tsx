import { Dialog as Base } from "@base-ui/react/dialog"
import type { ReactNode } from "react"
import { cn } from "./cn"
import { IconButton } from "./button"
import { Icon } from "./icon"
import { tr } from "../i18n/index"

export interface ModalDialogProps {
  open: boolean
  onClose: () => void
  children?: ReactNode
}

/** Overlay + centring layer around a panel. Exit is driven by the popup's
 * own `data-closed` animation, so the panel stays mounted until it finishes. */
export function ModalDialog({ open, onClose, children }: ModalDialogProps) {
  return (
    <Base.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Base.Portal>
        <Base.Backdrop data-component="dialog-overlay" style={{ zIndex: 50 }} />
        <div data-component="dialog-layer" style={{ zIndex: 50 }}>
          {children}
        </div>
      </Base.Portal>
    </Base.Root>
  )
}

export interface DialogProps {
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  size?: "normal" | "large" | "x-large"
  className?: string
  fit?: boolean
  transition?: boolean
  children?: ReactNode
}

/** The panel itself, rendered inside a `ModalDialog`. */
export function Dialog({ title, description, action, size, className, fit, transition, children }: DialogProps) {
  return (
    <div
      data-component="dialog"
      data-fit={fit ? true : undefined}
      data-size={size ?? "normal"}
      data-transition={transition ? true : undefined}
    >
      <div data-slot="dialog-container">
        <Base.Popup
          data-slot="dialog-content"
          data-no-header={!title && !action ? "" : undefined}
          className={cn(className)}
          // an explicit [autofocus] in the panel wins over the first tabbable
          initialFocus={(type) => {
            const el = document.querySelector("[data-slot='dialog-content'] [autofocus]")
            return el instanceof HTMLElement ? el : type === "keyboard"
          }}
        >
          {title || action ? (
            <div data-slot="dialog-header">
              {title ? <Base.Title data-slot="dialog-title">{title}</Base.Title> : null}
              {action ?? (
                <Base.Close
                  render={
                    <IconButton
                      data-slot="dialog-close-button"
                      icon={<Icon name="close" size={16} />}
                      variant="ghost"
                      aria-label={tr("Close")}
                    />
                  }
                />
              )}
            </div>
          ) : null}
          {description ? <Base.Description data-slot="dialog-description">{description}</Base.Description> : null}
          <div data-slot="dialog-body">{children}</div>
        </Base.Popup>
      </div>
    </div>
  )
}

export const DialogClose = Base.Close
