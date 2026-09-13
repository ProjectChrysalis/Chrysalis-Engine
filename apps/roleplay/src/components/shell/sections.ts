import { House, Chats, Users, UserCircle, SlidersHorizontal, BookOpenText, Lightning, PuzzlePiece, Plug, Gear, Storefront } from '@phosphor-icons/react'
import type { ViewKey } from '@/lib/store'

export interface SectionItem { key: ViewKey; label: string; icon: typeof House }

/** Every navigable section, in rail order. Regex lives inside Tools, one home only. */
export const SECTIONS: SectionItem[] = [
  { key: 'home', label: 'Home', icon: House },
  { key: 'chats', label: 'Chats', icon: Chats },
  { key: 'characters', label: 'Characters', icon: Users },
  { key: 'marketplace', label: 'Marketplace', icon: Storefront },
  { key: 'personas', label: 'Personas', icon: UserCircle },
  { key: 'presets', label: 'Presets', icon: SlidersHorizontal },
  { key: 'lorebooks', label: 'Lorebooks', icon: BookOpenText },
  { key: 'quickreplies', label: 'Shortcuts', icon: Lightning },
  { key: 'extensions', label: 'Tools', icon: PuzzlePiece },
  { key: 'connections', label: 'Connections', icon: Plug },
  { key: 'settings', label: 'Settings', icon: Gear },
]

export const sectionsFor = (keys: ViewKey[]): SectionItem[] =>
  keys.flatMap((k) => SECTIONS.filter((s) => s.key === k))
