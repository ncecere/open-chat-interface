import { type ReactNode, useState } from 'react';
import { Sidebar } from '~/components/layout/sidebar';
import { TopBar } from '~/components/layout/top-bar';
import { useAuthStatus } from '~/hooks/use-auth-status';

/**
 * Desktop shell: sidebar, a full-width top bar carrying the global controls,
 * and an inset rounded main panel below it.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { data: status } = useAuthStatus();

  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--bg-app)]">
      <Sidebar
        appName={status?.branding.appName}
        open={sidebarOpen}
        onToggle={() => setSidebarOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar sidebarOpen={sidebarOpen} onOpenSidebar={() => setSidebarOpen(true)} />

        <main className="scrollbar-thin min-h-0 flex-1 overflow-y-auto rounded-tl-xl bg-[var(--bg-root)] bg-[image:var(--root-gradient)]">
          {children}
        </main>
      </div>
    </div>
  );
}
