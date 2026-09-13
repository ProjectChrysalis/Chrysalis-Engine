
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "@/lib/utils"

function ScrollArea({
  className,
  children,
  ...props
}: ScrollAreaPrimitive.Root.Props) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      // `overflow-hidden` keeps the root from being stretched open by its own
      // content: without it a `flex-1` root inside a flex column resolves its
      // height from the content, the viewport's `height:100%` resolves against
      // that grown height, and scrollHeight === clientHeight — the pane simply
      // runs off the bottom of the screen with no way to scroll (the bug the
      // user hit in Lorebooks / Presets / Regex).
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        // `absolute inset-0` (via the utility below) would break content-sized
        // roots like `max-h-56`, so instead the viewport keeps `size-full` and
        // the root gets `overflow-hidden` above. `max-h-[inherit]` lets a
        // `max-h-*` root still cap the viewport, and `overscroll-contain` stops
        // scroll chaining to the page once the pane hits its end.
        className="size-full max-h-[inherit] overscroll-contain rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export { ScrollArea, ScrollBar }
