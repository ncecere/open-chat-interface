import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { ThemeMenu } from '~/components/layout/theme-menu';
import { UsageLimits } from '~/components/settings/usage-limits';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Select } from '~/components/ui/select';
import {
  type CurrentFeatures,
  type SettingsSummary,
  useCurrentUser,
} from '~/hooks/use-current-user';
import { authClient } from '~/lib/auth-client';
import {
  isApplePlatform,
  modifierKey,
  SHORTCUT_IDS,
  SHORTCUTS,
  shortcutKeys,
} from '~/lib/keyboard-shortcuts';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';

const TABS = [
  { to: '/settings', label: 'Account', exact: true },
  { to: '/settings/customization', label: 'Customization' },
  { to: '/settings/memory', label: 'Memory' },
  { to: '/settings/history', label: 'History' },
  { to: '/settings/models', label: 'Models' },
  { to: '/settings/sharing', label: 'Sharing' },
  { to: '/settings/connectors', label: 'Connectors' },
  { to: '/settings/attachments', label: 'Attachments' },
] as const;

type Tab = (typeof TABS)[number];

/** Send and New Line follow "Invert Send/New Line Behavior" (Customization). */
function messageShortcuts(invertSend: boolean, apple: boolean) {
  return invertSend
    ? [
        { label: 'Send Message', keys: [modifierKey(apple), 'Enter'] },
        { label: 'New Line', keys: ['Enter'] },
      ]
    : [
        { label: 'Send Message', keys: ['Enter'] },
        { label: 'New Line', keys: [apple ? '⇧' : 'Shift', 'Enter'] },
      ];
}

function isActive(tab: Tab, pathname: string) {
  return 'exact' in tab && tab.exact ? pathname === tab.to : pathname.startsWith(tab.to);
}

/**
 * Sections with nothing in them for this person are left out of the
 * navigation (v0.9.1): Memory when it is not offered to them and they have no
 * saved notes, Connectors when their role has nothing to connect, and
 * Sharing (v0.10) when they may not share and have no link left to revoke.
 * Their addresses still work, and the section shows while it is open. Until
 * /me says otherwise (or from an older API) every section shows.
 */
function visibleTabs(
  pathname: string,
  features: Partial<CurrentFeatures> | undefined,
  summary: SettingsSummary | undefined,
): Tab[] {
  return TABS.filter((tab) => {
    if (isActive(tab, pathname) || !summary) return true;
    if (tab.to === '/settings/memory')
      return features?.memory !== false || summary.memoryEntries > 0;
    if (tab.to === '/settings/connectors') return summary.connectors > 0;
    if (tab.to === '/settings/sharing')
      return features?.shareLinks !== false || (summary.shareLinks ?? 0) > 0;
    return true;
  });
}

/**
 * Who is signed in: a large avatar above the side cards on wide screens, a
 * compact row above the page on narrow ones.
 */
function Identity() {
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
    <div className="flex min-w-0 items-center gap-4 lg:flex-col lg:gap-3 lg:pt-2">
      {user.image ? (
        <img src={user.image} alt="" className="size-12 rounded-full object-cover lg:size-24" />
      ) : (
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-base font-semibold text-[var(--accent-foreground)] lg:size-24 lg:text-2xl">
          {initials}
        </span>
      )}
      <div className="min-w-0 flex-1 lg:flex-none lg:text-center">
        <p className="truncate text-base font-bold text-[var(--text-primary)] lg:text-xl">
          {user.name}
        </p>
        <p className="truncate text-sm text-[var(--text-muted)]">{user.email}</p>
      </div>
      <Badge variant="accent" className="shrink-0 px-3 py-1 text-xs capitalize">
        {user.role}
      </Badge>
    </div>
  );
}

function ShortcutsCard() {
  const { invertSend } = useTheme();
  const apple = isApplePlatform();
  const shortcuts = [
    ...SHORTCUT_IDS.map((id) => ({ label: SHORTCUTS[id].label, keys: shortcutKeys(id, apple) })),
    ...messageShortcuts(invertSend, apple),
  ];
  return (
    <div className="w-full rounded-xl border border-[var(--border-inset)] bg-[var(--bg-inset)] p-4">
      <h2 className="mb-3 text-sm font-semibold">Keyboard Shortcuts</h2>
      <div className="flex flex-col gap-3">
        {shortcuts.map((shortcut) => (
          <div key={shortcut.label} className="flex items-center justify-between gap-3">
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
  );
}

function HelpCard() {
  return (
    <div className="w-full rounded-xl border border-[var(--border-inset)] bg-[var(--bg-inset)] p-4">
      <h2 className="mb-2 text-sm font-semibold">Need help?</h2>
      <p className="text-sm text-[var(--text-muted)]">
        The administrator who runs this instance can reset passwords, change your role and enable
        more models.
      </p>
    </div>
  );
}

/**
 * The settings sections: tabs on one row where they fit, otherwise one menu.
 * Decided by the width of the content column (a container query), so it holds
 * whatever the window, sidebar or font size; the row never wraps or scrolls.
 * Eight tabs need about 44rem at the default font; the switch is at 50rem
 * (v0.10, was 46rem for seven) to keep room for wider fonts and labels.
 */
function SectionNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const { data } = useCurrentUser();
  const tabs = visibleTabs(pathname, data?.features, data?.settingsSummary);
  const current = tabs.find((tab) => isActive(tab, pathname)) ?? TABS[0];
  return (
    <div className="@container">
      <nav
        aria-label="Settings sections"
        className="hidden flex-nowrap gap-1 rounded-xl bg-[var(--bg-segment-track)] p-1 @[50rem]:inline-flex"
      >
        {tabs.map((tab) => {
          const active = isActive(tab, pathname);
          return (
            <Link
              key={tab.to}
              to={tab.to}
              // The router marks its own active link; Account must match exactly or
              // it would be "current" on every settings page.
              activeOptions={{ exact: 'exact' in tab && tab.exact }}
              className={cn(
                'whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm transition-colors',
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
      <div className="@[50rem]:hidden">
        <Select
          aria-label="Settings section"
          value={current.to}
          onChange={(to) => void navigate({ to })}
          options={tabs.map((tab) => ({ value: tab.to, label: tab.label }))}
          className="h-11"
        />
      </div>
    </div>
  );
}

export function SettingsLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function handleSignOut() {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: '/auth/login' });
  }

  return (
    <div className="min-h-dvh bg-[var(--bg-settings)]">
      <div className="mx-auto w-full max-w-[75rem] px-4 py-6 sm:px-6">
        <header className="flex items-center justify-between">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/">
              <ArrowLeft />
              Back to Chat
            </Link>
          </Button>

          <div className="flex items-center gap-1">
            <ThemeMenu />
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              Sign out
            </Button>
          </div>
        </header>

        {/*
          One grid, one copy of each part. Wide: identity and cards in a left
          column beside the page. Narrow: identity, then the page, then the cards.
        */}
        <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-10">
          <div className="lg:col-start-1 lg:row-start-1">
            <Identity />
          </div>

          <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            <SectionNav pathname={pathname} />
            <div className="mt-8 lg:pb-16">
              <Outlet />
            </div>
          </div>

          <div className="flex flex-col gap-6 pb-16 lg:col-start-1 lg:row-start-2 lg:self-start">
            <UsageLimits />
            <ShortcutsCard />
            <HelpCard />
          </div>
        </div>
      </div>
    </div>
  );
}
