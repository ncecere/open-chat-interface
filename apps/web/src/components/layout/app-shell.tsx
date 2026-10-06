import { useNavigate, useRouterState } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { UsageWarning } from '~/components/chat/usage-warning';
import { CommandPalette } from '~/components/command-palette/command-palette';
import { BroadcastBanner } from '~/components/layout/broadcast-banner';
import { ReadOnlyBanner } from '~/components/layout/read-only-banner';
import { Sidebar } from '~/components/layout/sidebar';
import { SkipLink } from '~/components/layout/skip-link';
import { TopBar } from '~/components/layout/top-bar';
import { useCommandPalette } from '~/hooks/use-command-palette';
import { useGlobalShortcuts } from '~/hooks/use-global-shortcuts';
import { cn } from '~/lib/utils';
import { TemporaryChatProvider, useTemporaryChat } from '~/providers/temporary-chat-provider';

/**
 * The global shortcuts, mounted inside the temporary chat provider because a
 * new chat started from the keyboard leaves temporary mode, like the button.
 */
function GlobalShortcuts({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const navigate = useNavigate();
  const { setTemporary } = useTemporaryChat();
  useGlobalShortcuts({
    onNewChat: () => {
      setTemporary(false);
      void navigate({ to: '/' });
    },
    onToggleSidebar,
  });
  return null;
}

/**
 * Desktop shell: sidebar, a full-width top bar carrying the global controls,
 * and an inset rounded main panel below it.
 */
const DOCKED_SIDEBAR = '(min-width: 1024px)';

export function AppShell({ children }: { children: ReactNode }) {
  // A drawer below 1024px, as on phones: docked at 768 it left the chat 512px,
  // wrapping the model name and squeezing Send (#109).
  const [mobile, setMobile] = useState(() => !window.matchMedia(DOCKED_SIDEBAR).matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => !mobile);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const previousPathname = useRef(pathname);
  const commandPalette = useCommandPalette();

  useEffect(() => {
    const query = window.matchMedia(DOCKED_SIDEBAR);
    const onChange = (event: MediaQueryListEvent) => {
      setMobile(!event.matches);
      setSidebarOpen(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // The mobile drawer closes after any successful navigation.
  useEffect(() => {
    const navigated = previousPathname.current !== pathname;
    previousPathname.current = pathname;
    if (mobile && navigated) setSidebarOpen(false);
  }, [mobile, pathname]);

  useEffect(() => {
    if (!mobile || !sidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSidebarOpen(false);
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[aria-label="Open sidebar"]')?.focus();
      });
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobile, sidebarOpen]);

  function closeSidebar() {
    setSidebarOpen(false);
    if (mobile) {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[aria-label="Open sidebar"]')?.focus();
      });
    }
  }

  return (
    <TemporaryChatProvider>
      <GlobalShortcuts
        onToggleSidebar={() => (sidebarOpen ? closeSidebar() : setSidebarOpen(true))}
      />
      <div className="flex h-dvh overflow-hidden bg-[var(--bg-app)]">
        <SkipLink />
        <Sidebar open={sidebarOpen} mobile={mobile} onToggle={closeSidebar} />

        <div
          className="flex min-w-0 flex-1 flex-col"
          inert={mobile && sidebarOpen ? true : undefined}
        >
          <TopBar
            sidebarOpen={sidebarOpen}
            onOpenSidebar={() => setSidebarOpen(true)}
            onOpenCommandPalette={commandPalette.show}
          />
          <main className="flex min-h-0 flex-1 flex-col rounded-tl-xl bg-[var(--bg-root)] bg-[image:var(--root-gradient)]">
            {/*
             * The top bar's floating controls (absolute, top-6, about 2.6rem
             * tall) get a strip of their own, always: the page scrolls below
             * it rather than under them, where they hid a conversation's first
             * lines (#166). Announcements sit below the strip, outside the
             * scroller, so they are not lost when the conversation scrolls.
             */}
            <div
              data-banners
              className={cn('shrink-0', sidebarOpen ? 'pt-[3.25rem]' : 'pt-[4.25rem]')}
            >
              <ReadOnlyBanner />
              <BroadcastBanner />
            </div>
            <div
              id="main-content"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access per WCAG 2.1.1, and this doubles as the skip-link target
              tabIndex={0}
              className="scrollbar-thin min-h-0 flex-1 overflow-y-auto"
            >
              {children}
            </div>
          </main>
        </div>

        {/* Mounted on the shell rather than a page: the shell survives
            navigation between chats, so a warning is announced once instead of
            again on every route change. */}
        <UsageWarning />

        <CommandPalette
          open={commandPalette.open}
          onOpenChange={commandPalette.setOpen}
          sidebarOpen={sidebarOpen}
          onSidebarOpenChange={setSidebarOpen}
        />
      </div>
    </TemporaryChatProvider>
  );
}
