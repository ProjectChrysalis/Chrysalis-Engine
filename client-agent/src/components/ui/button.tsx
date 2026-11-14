import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-(--control-radius) border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap outline-none select-none transition-[background-color,color,box-shadow,scale] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:not-aria-[haspopup]:scale-[0.97] disabled:pointer-events-none disabled:opacity-64 aria-invalid:border-destructive pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 pointer-coarse:after:size-full [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs shadow-primary/24 inset-shadow-[0_1px_rgb(255_255_255/16%)] hover:bg-primary/90 active:inset-shadow-none",
        outline:
          "border-input bg-popover text-foreground shadow-xs/5 hover:bg-accent dark:bg-input/32 dark:hover:bg-input/64 aria-expanded:bg-accent",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-accent aria-expanded:bg-accent",
        ghost:
          "text-foreground hover:bg-accent aria-expanded:bg-accent data-pressed:bg-accent",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/16 focus-visible:ring-destructive/40 dark:bg-destructive/16 dark:hover:bg-destructive/24",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 gap-1.5 px-3 sm:h-8",
        xs: "h-7 gap-1 rounded-md px-2 text-xs sm:h-6 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-2.5 text-[0.8125rem] sm:h-7 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-1.5 px-3.5 sm:h-9",
        icon: "size-9 sm:size-8",
        "icon-xs": "size-7 rounded-md sm:size-6 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-8 sm:size-7",
        "icon-lg": "size-10 sm:size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
