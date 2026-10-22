// Shell iconography. Names are the shell's own vocabulary; each maps to a
// Phosphor glyph so a rename here never ripples into markup.
import type { ComponentPropsWithoutRef } from "react"
import {
  ArrowClockwise, ArrowLeft, ArrowSquareOut, ArrowUUpLeft, Brain, CaretDown, CaretLeft, CaretRight,
  Chat, ChartBar, ChatCircle, CheckCircle, ClockCounterClockwise, CloudArrowUp, Code, Columns, Copy, DownloadSimple, FolderPlus, GearSix, HardDrives, Info,
  Lock, PencilSimpleLine, Plus, PlusSquare, Prohibit, SignOut, SlidersHorizontal,
  SpeakerHigh, SquaresFour, Stop, Storefront, TerminalWindow, Trash, X,
} from "@phosphor-icons/react"

const glyphs = {
  "arrow-left": ArrowLeft,
  "arrow-undo-down": ArrowUUpLeft,
  backup: ClockCounterClockwise,
  brain: Brain,
  "bubble-5": ChatCircle,
  chart: ChartBar,
  "circle-ban-sign": Prohibit,
  "circle-check": CheckCircle,
  "cloud-upload": CloudArrowUp,
  code: Code,
  copy: Copy,
  download: DownloadSimple,
  info: Info,
  lock: Lock,
  logout: SignOut,
  "pencil-line": PencilSimpleLine,
  trash: Trash,
  providers: SquaresFour,
  rebuild: ArrowClockwise,
  server: HardDrives,
  speaker: SpeakerHigh,
  stop: Stop,
  store: Storefront,
  "speech-bubble": Chat,
  "terminal-active": TerminalWindow,
  "chevron-left": CaretLeft,
  "chevron-right": CaretRight,
  "chevron-down": CaretDown,
  "folder-add-left": FolderPlus,
  "grid-plus": Plus,
  "outline-chevron-down": CaretDown,
  "outline-sliders": SlidersHorizontal,
  "outline-square-arrow": ArrowSquareOut,
  "outline-xmark": X,
  plus: Plus,
  "settings-gear": GearSix,
  split: Columns,
  "workspace-new": PlusSquare,
  "xmark-small": X,
  close: X,
} as const

export type IconName = keyof typeof glyphs

/** Named steps so call sites can ask for a size without knowing pixels; a
 * raw number still wins when a specific one is needed. */
export type IconSize = "small" | "normal" | "large"

export interface IconProps extends Omit<ComponentPropsWithoutRef<"svg">, "name" | "size"> {
  name: IconName
  size?: IconSize | number
}

const px = (size: IconProps["size"], steps: Record<IconSize, number>, fallback: number) =>
  size === undefined ? fallback : typeof size === "number" ? size : steps[size]

/** Shell icon at the body-text size. */
export function Icon({ name, size, ...rest }: IconProps) {
  const Glyph = glyphs[name]
  return <Glyph size={px(size, { small: 16, normal: 20, large: 24 }, 18)} data-component="icon" {...rest} />
}

/** Compact icon for dense chrome — tab rails, inline buttons. */
export function IconSmall({ name, size, ...rest }: IconProps) {
  const Glyph = glyphs[name]
  return <Glyph size={px(size, { small: 14, normal: 16, large: 20 }, 16)} data-component="icon" {...rest} />
}
