
import { useState } from 'react'
import { List } from '@phosphor-icons/react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useApp } from '@/lib/store'
import { cn } from '@/lib/utils'
import { SECTIONS } from '@/components/shell/sections'

const PRIMARY = new Set(['home', 'chats', 'characters'])
const primaryTabs = SECTIONS.filter((s) => PRIMARY.has(s.key))
const moreItems = SECTIONS.filter((s) => !PRIMARY.has(s.key))

export function MobileTabBar() {
  const view = useApp((s) => s.view)
  const navigate = useApp((s) => s.navigate)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreActive = moreItems.some((i) => i.key === view)

  return (
    <>
      <nav
        aria-label="Primary"
        className="flex shrink-0 items-stretch border-t border-border bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {primaryTabs.map((item) => {
          const active = view === item.key || (item.key === 'chats' && view === 'chat')
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => navigate(item.key)}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium',
                active ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <item.icon className="size-5" aria-hidden="true" />
              {item.label}
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-label="More sections"
          className={cn(
            'flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium',
            moreActive ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <List className="size-5" aria-hidden="true" />
          More
        </button>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="pb-[calc(env(safe-area-inset-bottom)+1rem)]">
          <SheetHeader>
            <SheetTitle>All sections</SheetTitle>
          </SheetHeader>
          <div className="grid grid-cols-4 gap-2 px-4 pb-2">
            {moreItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => { navigate(item.key); setMoreOpen(false) }}
                className={cn(
                  'flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-lg border text-[11px]',
                  view === item.key
                    ? 'border-primary/40 bg-accent text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <item.icon className="size-5" aria-hidden="true" />
                {item.label}
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
