import { type ReactNode, useState } from 'react';
import { CommandPalette } from '~/components/command-palette/command-palette';
import { Sidebar } from '~/components/layout/sidebar';
import { SkipLink } from '~/components/layout/skip-link';
import { TopBar } from '~/components/layout/top-bar';
import { useAuthStatus } from '~/hooks/use-auth-status';
import { useCommandPalette } from '~/hooks/use-command-palette';
import { TemporaryChatProvider } from '~/providers/temporary-chat-provider';

/**
 * Desktop shell: sidebar, a full-width top bar carrying the global controls,
 * and an inset rounded main panel below it.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const commandPalette = useCommandPalette();
  const { data: status } = useAuthStatus();

  return (
    <TemporaryChatProvider>
      <div className="flex h-dvh overflow-hidden bg-[var(--bg-app)]">
        <SkipLink />
        <Sidebar
          appName={status?.branding.appName}
          open={sidebarOpen}
          onToggle={() => setSidebarOpen(false)}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            sidebarOpen={sidebarOpen}
            onOpenSidebar={() => setSidebarOpen(true)}
            onOpenCommandPalette={commandPalette.show}
          />
          <main className="min-h-0 flex-1 rounded-tl-xl bg-[var(--bg-root)] bg-[image:var(--root-gradient)]">
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs
                keyboard access per WCAG 2.1.1, and this doubles as the skip-link target */}
            <div id="main-content" tabIndex={0} className="scrollbar-thin h-full overflow-y-auto">
              {children}
            </div>
          </main>
        </div>

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
