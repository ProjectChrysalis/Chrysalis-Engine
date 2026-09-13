
import { useEffect, useState } from 'react'
import { CircleNotch } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { Toaster } from '@/components/ui/sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useApp, DRAWER_VIEWS, type ViewKey } from '@/lib/store'
import { takeReloadReason } from '@/lib/engine'
import { useIsDesktop } from '@/hooks/use-mobile'
import { useBackClose } from '@/hooks/use-back-close'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { HomeView } from '@/components/views/home-view'
import { CharactersView } from '@/components/views/characters-view'
import { MarketplaceView } from '@/components/views/marketplace-view'
import { ChatsView } from '@/components/views/chats-view'
import { ChatView } from '@/components/chat/chat-view'
import { PersonasView } from '@/components/views/personas-view'
import { PresetsView } from '@/components/views/presets-view'
import { LorebooksView } from '@/components/views/lorebooks-view'
import { QuickRepliesView } from '@/components/views/quickreplies-view'
import { ExtensionsView } from '@/components/views/extensions-view'
import { ConnectionsView } from '@/components/views/connections-view'
import { SettingsView } from '@/components/views/settings-view'
import { ThemeApplier } from '@/components/theme-applier'
import { MobileTabBar } from '@/components/shell/mobile-tab-bar'
import { SECTIONS } from '@/components/shell/sections'

export function AppShell() {
  const [mounted, setMounted] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const view = useApp((s) => s.view)
  // a boolean, never the streaming object: subscribing to the object here
  // re-rendered the whole shell on every token
  const streaming = useApp((s) => s.streaming !== null)
  const boot = useApp((s) => s.boot)
  const bootError = useApp((s) => s.bootError)
  const hydrate = useApp((s) => s.hydrate)
  const isDesktop = useIsDesktop()

  useEffect(() => setMounted(true), [])

  // Desktop invariant: the page behind is always home/chats/chat. A persisted
  // drawer-section view (or a mobile session resized wide) becomes a drawer.
  // Mobile only has drawers over an open chat: one still open once the chat
  // is gone (or the window shrinks off a desktop page) becomes the page.
  useEffect(() => {
    const { view: v, drawer } = useApp.getState()
    if (isDesktop) {
      if (DRAWER_VIEWS.has(v)) useApp.setState({ drawer: v, view: 'home' })
    } else if (drawer && v !== 'chat') {
      useApp.setState({ view: drawer, drawer: null })
    }
  }, [isDesktop, view])
  // Mobile back, outermost first (declaration order is push order): any tab
  // but Home returns to Home, however many tabs were flipped through; an open
  // chat returns to the chat list like its own back button. The section
  // drawer is a sheet, and sheets, dialogs and detail pages carry their own
  // layers above these.
  useBackClose(view !== 'home', () => useApp.getState().setView('home'))
  useBackClose(view === 'chat', () => useApp.getState().closeChat())

  // engine hydrate — characters/chats/personas/presets/lorebooks/regex/models
  useEffect(() => { void hydrate() }, [hydrate])

  // A reload the app asked for explains itself once it lands. Nothing shown
  // here means the reload came from the browser, not from the app.
  useEffect(() => {
    const reason = takeReloadReason()
    if (reason) toast(reason)
  }, [])

  // Mobile keyboards shrink the VISUAL viewport only — dvh keeps the layout
  // full-height and buries the composer (and the bottom of the chat) under
  // the keyboard, making the last messages unreachable until it closes.
  // Track the visible height and size the shell to it, so the chat log keeps
  // its scrollable area while typing. The scroll clamp kills the residual
  // page pan browsers apply while the keyboard is up.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const apply = () => {
      const focused = document.activeElement
      const editing = focused instanceof HTMLElement && (focused.matches('input, textarea') || focused.isContentEditable)
      setKeyboardOpen(window.matchMedia('(pointer: coarse)').matches && editing)
      document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
      if (window.scrollY !== 0) window.scrollTo(0, 0)
      if (document.documentElement.scrollTop !== 0) document.documentElement.scrollTop = 0
    }
    apply()
    document.addEventListener('focusin', apply)
    document.addEventListener('focusout', apply)
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      document.removeEventListener('focusin', apply)
      document.removeEventListener('focusout', apply)
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      document.documentElement.style.removeProperty('--vvh')
    }
  }, [])

  if (!mounted || boot === 'loading') {
    return (
      <div className="flex items-center justify-center bg-background" style={{ height: 'var(--vvh, 100dvh)' }}>
        <CircleNotch className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Loading</span>
      </div>
    )
  }

  if (boot === 'error') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 bg-background px-6 text-center" style={{ height: 'var(--vvh, 100dvh)' }}>
        <p className="text-sm font-medium text-foreground">Can&apos;t reach the Chrysalis engine</p>
        <p className="max-w-sm text-xs text-muted-foreground">{bootError}</p>
        <Button variant="outline" size="sm" onClick={() => void hydrate()}>Retry</Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col bg-background text-foreground" style={{ height: 'var(--vvh, 100dvh)' }}>
      <ThemeApplier />
      <div className="flex min-h-0 flex-1">
        <IconRail />
        <main className="min-w-0 flex-1 overflow-hidden">
          {renderView(view)}
        </main>
      </div>
      {view !== 'chat' && !keyboardOpen && <MobileTabBar />}
      <SectionDrawer isDesktop={isDesktop} />
      {/* Live generation status, below the header line at the right edge:
          clear of the header buttons, the composer, toasts and quick replies. */}
      {streaming && (
        <span className="pointer-events-none fixed top-14 right-2 z-30 flex items-center gap-1 rounded-md border border-border bg-popover/90 px-1.5 py-1 text-[11px] text-primary backdrop-blur">
          <CircleNotch className="size-3 animate-spin" aria-hidden="true" />
          generating…
        </span>
      )}
      <Toaster position={isDesktop ? "bottom-right" : "top-center"} visibleToasts={isDesktop ? 3 : 1} closeButton />
    </div>
  )
}

/** The one mounted view for a section key — the page on mobile and (for the
 *  home/chat surfaces) on desktop too; drawer sections render through the
 *  same component inside SectionDrawer. */
function renderView(v: ViewKey) {
  switch (v) {
    case 'home': return <HomeView />
    case 'chats': return <ChatsView />
    case 'chat': return <ChatView />
    case 'characters': return <CharactersView />
    case 'marketplace': return <MarketplaceView />
    case 'personas': return <PersonasView />
    case 'presets': return <PresetsView />
    case 'lorebooks': return <LorebooksView />
    case 'quickreplies': return <QuickRepliesView />
    case 'extensions': return <ExtensionsView />
    case 'connections': return <ConnectionsView />
    case 'settings': return <SettingsView />
  }
}

/** Section drawer: the page behind stays mounted (a chat keeps its scroll and
 *  any running stream) and closing the drawer drops you right back into it.
 *  Desktop: slides over the left part of the screen beside the rail and stops
 *  short of the right edge; clicking the uncovered side or Esc closes it.
 *  Mobile: covers the open chat below its section bar, full width. */
function SectionDrawer({ isDesktop }: { isDesktop: boolean }) {
  const drawer = useApp((s) => s.drawer)
  const closeDrawer = useApp((s) => s.closeDrawer)
  const label = SECTIONS.find((i) => i.key === drawer)?.label ?? ''
  return (
    // non-modal and without pointer dismissal: the rail (or the chat's section
    // bar) stays live, since pressing it must not read as an outside-close; the
    // page area closes via the backdrop's own click, Esc and the X keep working
    <Sheet modal={false} disablePointerDismissal open={!!drawer} onOpenChange={(open) => { if (!open) closeDrawer() }}>
      <SheetContent
        // it comes out of whatever opened it: the rail on desktop, the bar
        // above it on mobile
        side={isDesktop ? 'left' : 'top'}
        aria-label={label}
        // the drawer and its dim sit beside the rail / below the section bar,
        // never over it: it stays clickable to flip sections or close
        overlayClassName={isDesktop ? 'left-12' : 'top-11'}
        onOverlayClick={closeDrawer}
        className={cn(
          'gap-0',
          isDesktop
            ? 'data-[side=left]:left-12 data-[side=left]:w-[min(720px,75vw)] data-[side=left]:sm:max-w-none'
            : 'data-[side=top]:top-11 data-[side=top]:bottom-0 data-[side=top]:max-h-none',
        )}
        // mobile: the section bar's lit icon is the title, and tapping it again closes
        showCloseButton={isDesktop}
      >
        {isDesktop && (
          <div className="flex h-11 shrink-0 items-center border-b border-border pr-12 pl-4 text-sm font-medium">
            {label}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          {drawer && renderView(drawer)}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function IconRail() {
  const view = useApp((s) => s.view)
  const drawer = useApp((s) => s.drawer)
  const navigate = useApp((s) => s.navigate)
  const closeDrawer = useApp((s) => s.closeDrawer)

  return (
    <nav aria-label="Primary sections" className="hidden w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-2 md:flex">
      {SECTIONS.map((item) => {
        const active = view === item.key || (view === 'chat' && item.key === 'chats') || drawer === item.key
        return (
          <Tooltip key={item.key}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => {
                    // clicking the open drawer's icon toggles it shut; page
                    // items close whatever drawer is open on the way there
                    if (drawer === item.key) { closeDrawer(); return }
                    if (!DRAWER_VIEWS.has(item.key)) closeDrawer()
                    navigate(item.key)
                  }}
                  aria-label={item.label}
                  className={cn(
                    'relative flex size-9 items-center justify-center rounded-md transition-colors',
                    active ? 'bg-accent text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <item.icon className="size-4.5" aria-hidden="true" />
                </button>
              }
            />
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        )
      })}
    </nav>
  )
}
