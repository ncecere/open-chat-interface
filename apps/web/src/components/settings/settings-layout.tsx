import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Moon, Sun } from 'lucide-react';
import { UsageLimits } from '~/components/settings/usage-limits';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { useCurrentUser } from '~/hooks/use-current-user';
import { authClient } from '~/lib/auth-client';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';

const TABS = [
  { to: '/settings', label: 'Account', exact: true },
  { to: '/settings/customization', label: 'Customization' },
  { to: '/settings/history', label: 'History & Sync' },
  { to: '/settings/models', label: 'Models' },
  { to: '/settings/connectors', label: 'Connectors' },
  { to: '/settings/attachments', label: 'Attachments' },
  { to: '/settings/shortcuts', label: 'Shortcuts' },
  { to: '/settings/contact', label: 'Contact Us' },
] as const;

const SHORTCUTS = [
  { label: 'Search', keys: ['⌘', 'K'] },
  { label: 'New Chat', keys: ['⌘', '⇧', 'O'] },
  { label: 'Toggle Sidebar', keys: ['⌘', 'B'] },
  { label: 'Open Model Picker', keys: ['⌘', '/'] },
];

function IdentityRail() {
  const { data } = useCurrentUser();
  if (!data) return null;

  const { user } = data;
  const initials = user.name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="flex w-60 shrink-0 flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-3 pt-2">
        {user.image ? (
          <img src={user.image} alt="" className="size-40 rounded-full object-cover" />
        ) : (
          <span className="flex size-40 items-center justify-center rounded-full bg-[var(--accent)] text-4xl font-semibold text-[var(--accent-foreground)]">
            {initials}
          </span>
        )}
        <div className="text-center">
          <p className="text-xl font-bold text-[var(--text-primary)]">{user.name}</p>
          <p className="text-sm text-[var(--text-muted)]">{user.email}</p>
        </div>
        <Badge variant="accent" className="px-3 py-1 text-xs capitalize">
          {user.role}
        </Badge>
      </div>

      <UsageLimits />

      <div className="w-full rounded-xl border border-[var(--border-inset)] bg-[var(--bg-inset)] p-4">
        <p className="mb-3 text-sm font-semibold">Keyboard Shortcuts</p>
        <div className="flex flex-col gap-3">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.label} className="flex items-center justify-between">
              <span className="text-sm text-[var(--text-secondary)]">{shortcut.label}</span>
              <span className="flex gap-1">
                {shortcut.keys.map((key) => (
                  <kbd
                    key={key}
                    className="rounded bg-[var(--bg-control-hover)] px-1.5 py-0.5 text-[0.6875rem] text-[var(--text-secondary)]"
                  >
                    {key}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SettingsLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTheme, setTheme } = useTheme();

  async function handleSignOut() {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: '/auth/login' });
  }

  return (
    <div className="min-h-dvh bg-[var(--bg-settings)]">
      <div className="mx-auto w-full max-w-[75rem] px-6 py-6">
        <header className="flex items-center justify-between">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/">
              <ArrowLeft />
              Back to Chat
            </Link>
          </Button>

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Toggle theme"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            >
              {resolvedTheme === 'dark' ? <Moon /> : <Sun />}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              Sign out
            </Button>
          </div>
        </header>

        <div className="mt-8 flex gap-10">
          <IdentityRail />

          <div className="min-w-0 flex-1">
            <nav className="inline-flex flex-wrap gap-1 rounded-xl bg-[var(--bg-segment-track)] p-1">
              {TABS.map((tab) => {
                const active =
                  'exact' in tab && tab.exact ? pathname === tab.to : pathname.startsWith(tab.to);

                return (
                  <Link
                    key={tab.to}
                    to={tab.to}
                    className={cn(
                      'rounded-lg px-3 py-1.5 text-sm transition-colors',
                      active
                        ? 'bg-[var(--bg-segment-active)] font-medium text-[var(--text-primary)]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    {tab.label}
                  </Link>
                );
              })}
            </nav>

            <div className="mt-8 pb-16">
              <Outlet />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
