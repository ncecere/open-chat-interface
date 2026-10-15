import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { UnsavedChangesGuard } from '~/components/admin/unsaved-changes';
import { ReadOnlyBanner } from '~/components/layout/read-only-banner';
import { SkipLink } from '~/components/layout/skip-link';
import { ThemeMenu } from '~/components/layout/theme-menu';
import { UsageLimits } from '~/components/settings/usage-limits';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { LoadingOverlay, useFirstLoadSettled } from '~/components/ui/reveal-when-loaded';
import { Select } from '~/components/ui/select';
import {
  type CurrentFeatures,
  type SettingsSummary,
  useCurrentUser,
} from '~/hooks/use-current-user';
import { authClient } from '~/lib/auth-client';
import { type MessageKey, useT } from '~/lib/i18n';
import { isApplePlatform, modifierKey, SHORTCUT_IDS, shortcutKeys } from '~/lib/keyboard-shortcuts';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';

const TABS = [
  { to: '/settings', label: 'settings.layout.tab.account', exact: true },
  { to: '/settings/customization', label: 'settings.layout.tab.customization' },
  { to: '/settings/memory', label: 'settings.layout.tab.memory' },
  { to: '/settings/history', label: 'settings.layout.tab.history' },
  { to: '/settings/models', label: 'settings.layout.tab.models' },
  { to: '/settings/sharing', label: 'settings.layout.tab.sharing' },
  { to: '/settings/groups', label: 'settings.layout.tab.groups' },
  { to: '/settings/connectors', label: 'settings.layout.tab.connectors' },
  { to: '/settings/attachments', label: 'settings.layout.tab.attachments' },
] as const satisfies readonly { to: string; label: MessageKey; exact?: boolean }[];

/** The shortcut descriptions are translated here; the key names are not. */
const SHORTCUT_LABELS: Record<(typeof SHORTCUT_IDS)[number], MessageKey> = {
  search: 'settings.layout.shortcut.search',
  'new-chat': 'settings.layout.shortcut.newChat',
  'toggle-sidebar': 'settings.layout.shortcut.toggleSidebar',
  'model-picker': 'settings.layout.shortcut.modelPicker',
};

type Tab = (typeof TABS)[number];

/** Send and New Line follow "Invert Send/New Line Behavior" (Customization). */
function messageShortcuts(
  invertSend: boolean,
  apple: boolean,
): { label: MessageKey; keys: string[] }[] {
  return invertSend
    ? [
        { label: 'settings.layout.shortcut.send', keys: [modifierKey(apple), 'Enter'] },
        { label: 'settings.layout.shortcut.newLine', keys: ['Enter'] },
      ]
    : [
        { label: 'settings.layout.shortcut.send', keys: ['Enter'] },
        { label: 'settings.layout.shortcut.newLine', keys: [apple ? '⇧' : 'Shift', 'Enter'] },
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
    // Groups (v0.14) is for managers only: nothing is shown until /me says the
    // person manages a group, also from an older API that does not say.
    if (tab.to === '/settings/groups')
      return isActive(tab, pathname) || (summary?.managedGroups ?? 0) > 0;
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
  // Until /me answers, the avatar's room is kept: on a phone the row sits
  // above the page, and arriving late it pushed the page down 48 px (#200).
  if (!data) return <div data-identity-placeholder aria-hidden="true" className="h-12 lg:h-24" />;

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
  const t = useT();
  const { invertSend } = useTheme();
  const apple = isApplePlatform();
  const shortcuts = [
    ...SHORTCUT_IDS.map((id) => ({ label: SHORTCUT_LABELS[id], keys: shortcutKeys(id, apple) })),
    ...messageShortcuts(invertSend, apple),
  ];
  return (
    // Only where there is a mouse or trackpad, and so most likely a keyboard:
    // ⌘ shortcuts on a phone are noise (#106). A tablet with a trackpad keeps it.
    <div
      data-testid="shortcuts-card"
      className="hidden w-full rounded-xl border border-[var(--border-inset)] bg-[var(--bg-inset)] p-4 any-pointer-fine:block"
    >
      <h2 className="mb-3 text-sm font-semibold">{t('settings.layout.shortcuts')}</h2>
      <div className="flex flex-col gap-3">
        {shortcuts.map((shortcut) => (
          <div key={shortcut.label} className="flex items-center justify-between gap-3">
            <span className="text-sm text-[var(--text-secondary)]">{t(shortcut.label)}</span>
            {/* Key combinations read Ctrl then K in every language. */}
            <span dir="ltr" className="flex gap-1">
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
  const t = useT();
  return (
    <div className="w-full rounded-xl border border-[var(--border-inset)] bg-[var(--bg-inset)] p-4">
      <h2 className="mb-2 text-sm font-semibold">{t('settings.layout.helpTitle')}</h2>
      <p className="text-sm text-[var(--text-muted)]">{t('settings.layout.helpBody')}</p>
    </div>
  );
}

/**
 * The settings sections: tabs on one row where they fit, otherwise one menu.
 * Decided by the width of the content column (a container query), so it holds
 * whatever the window, sidebar or font size; the row never wraps or scrolls.
 * Eight tabs need about 44rem at the default font, and Groups, shown only to
 * managers, adds about 4.5rem; the switch is at 50rem (v0.10, was 46rem for
 * seven) to keep room for wider fonts and labels.
 */
function SectionNav({ pathname }: { pathname: string }) {
  const t = useT();
  const navigate = useNavigate();
  const { data } = useCurrentUser();
  const tabs = visibleTabs(pathname, data?.features, data?.settingsSummary);
  const current = tabs.find((tab) => isActive(tab, pathname)) ?? TABS[0];
  return (
    // One landmark for the tabs and the menu that replaces them: the menu was
    // outside every landmark on narrow screens (#272).
    <nav aria-label={t('settings.layout.sectionsNav')} className="@container">
      <div
        data-section-tabs
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
              {t(tab.label)}
            </Link>
          );
        })}
      </div>
      <div className="@[50rem]:hidden">
        <Select
          aria-label={t('settings.layout.sectionSelect')}
          value={current.to}
          onChange={(to) => void navigate({ to })}
          options={tabs.map((tab) => ({ value: tab.to, label: t(tab.label) }))}
          className="h-11"
        />
      </div>
    </nav>
  );
}

export function SettingsLayout() {
  const t = useT();
  const { pathname } = useLocation();
  const loaded = useFirstLoadSettled(pathname);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function handleSignOut() {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: '/auth/login' });
  }

  return (
    // Leaving a section with an edit not saved asks first, as administration
    // does (#45, #300): a default model picked and not saved looked applied (#314).
    <UnsavedChangesGuard>
      <div className="min-h-dvh bg-[var(--bg-settings)]">
        {/* Past Back to Chat, the menus and the section tabs to the page (#173). */}
        <SkipLink />
        <div className="mx-auto w-full max-w-[75rem] px-4 py-6 sm:px-6">
          <header className="flex items-center justify-between">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/">
                <ArrowLeft className="rtl:-scale-x-100" />
                {t('settings.layout.backToChat')}
              </Link>
            </Button>

            <div className="flex items-center gap-1">
              <ThemeMenu />
              <Button variant="ghost" size="sm" onClick={handleSignOut}>
                {t('settings.layout.signOut')}
              </Button>
            </div>
          </header>

          {/*
          One grid, one copy of each part. Wide: identity and cards in a left
          column beside the page. Narrow: identity, then the page, then the cards.
        */}
          <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-10">
            {/* Landmarks of their own, like the page beside them: they were
              outside every landmark, so landmark navigation skipped them (#272). */}
            <section
              aria-label={t('settings.layout.profile')}
              className="lg:col-start-1 lg:row-start-1"
            >
              <Identity />
            </section>

            <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
              <SectionNav pathname={pathname} />
              {/* The section itself is the page's main landmark and the skip
                link's target, as in the chat shell and admin (#173). */}
              <main id="main-content" tabIndex={-1} className="outline-none">
                {/* Read-only maintenance mode (v0.11): why changes are not saved. */}
                <ReadOnlyBanner className="mt-6 rounded-xl border" />
                {/* The page and the cards are shown once the page's first data is
                  in: on phones the cards follow the page, and were pushed down
                  in view as it filled in (#104). */}
                <div className="relative mt-8 lg:pb-16" aria-busy={!loaded}>
                  {!loaded && <LoadingOverlay label={t('settings.layout.loading')} />}
                  <div className={loaded ? undefined : 'invisible'}>
                    <Outlet />
                  </div>
                </div>
              </main>
            </div>

            <aside
              aria-label={t('settings.layout.usageAndHelp')}
              className={cn(
                'flex flex-col gap-6 pb-16 lg:col-start-1 lg:row-start-2 lg:self-start',
                !loaded && 'invisible',
              )}
            >
              <UsageLimits />
              <ShortcutsCard />
              <HelpCard />
            </aside>
          </div>
        </div>
      </div>
    </UnsavedChangesGuard>
  );
}
