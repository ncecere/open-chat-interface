import { MFA_CHALLENGE_PATH, MFA_SETUP_PATH } from '@oci/shared';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  useRouterState,
} from '@tanstack/react-router';
import { AppShell } from '~/components/layout/app-shell';
import { MfaGate } from '~/components/mfa/mfa-gate';
import { OnboardingGate } from '~/components/onboarding/onboarding-gate';
import { NotFoundPage } from '~/components/ui/not-found-page';
import { RouteLoadError } from '~/components/ui/route-load-error';
import { FullPageSpinner } from '~/components/ui/spinner';
import { useNewChatKey } from '~/hooks/use-new-chat-key';
import {
  validateGroupSearch,
  validateModelsSearch,
  validateRolesSearch,
  validateStorageSearch,
  validateUsageSearch,
  validateUsersSearch,
} from '~/lib/admin-search';
import { ApiError, api } from '~/lib/api-client';
import {
  validateChatHomeSearch,
  validateChatThreadSearch,
  validateProjectSearch,
} from '~/lib/chat-search-params';
import { onMfaRequired } from '~/lib/mfa-required';
import { returnPathFromSearch, signInSearch } from '~/lib/return-path';
import { noteSessionConfirmed, onSessionEnded, SIGNED_OUT_PARAM } from '~/lib/session-ended';
import { redirectRemovedConversation } from '~/lib/unused-conversation-route';
import { failedVerificationCode, VERIFY_EMAIL_PAGE } from '~/lib/verify-email-link';
import { AcceptInvitePage } from '~/routes/auth/accept-invite';
import { LoginPage } from '~/routes/auth/login';
import { ForgotPasswordPage, ResetPasswordPage } from '~/routes/auth/password-reset';
import { SignupPage } from '~/routes/auth/signup';
import { VerifyEmailPage } from '~/routes/auth/verify-email';
import { ChatHomePage } from '~/routes/chat/home';
import { ChatThreadPage } from '~/routes/chat/thread';
import { PublicSharePage } from '~/routes/share/public-share';

interface SessionSnapshot {
  user: { id: string; role: string };
  /** Absent from an API without two-step verification (before v0.14). */
  mfa?: { limited: boolean };
}

/**
 * A person whose role requires two-step verification, and who has not completed
 * it in this session, may use only the setup page and sign-out: the server
 * refuses everything else (403 MFA_ENROLMENT_REQUIRED, #399), so a page of the
 * app would only show errors.
 */
function sendLimitedToSetup(session: SessionSnapshot): void {
  if (session.mfa?.limited) throw redirect({ to: MFA_SETUP_PATH, replace: true });
}

/** The session this tab last confirmed; null once it is known to have ended. */
let confirmedSession: SessionSnapshot | null = null;

/**
 * Route guards read the session directly so redirects happen before render.
 *
 * Only a 401 says the session has ended. Any other failure (the database away
 * for a few seconds: a 500, a network error) says nothing about it, and every
 * navigation runs this, so it replaced the whole app with "Could not load
 * this page" until a reload. Within an app already signed in, navigation now
 * carries on with the session last confirmed, and the page's own requests
 * show their retry states; only a first load, with nothing confirmed yet,
 * fails (#164).
 */
export async function loadSession(): Promise<SessionSnapshot | null> {
  try {
    confirmedSession = await api.get<SessionSnapshot>('/me');
    noteSessionConfirmed();
    return confirmedSession;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      confirmedSession = null;
      return null;
    }
    if (confirmedSession) return confirmedSession;
    throw error;
  }
}

const rootRoute = createRootRoute({
  component: Outlet,
  // An address outside every layout: the page itself is the landmark (#131).
  notFoundComponent: () => (
    <main className="h-dvh">
      <NotFoundPage />
    </main>
  ),
});

const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/signup',
  component: SignupPage,
  beforeLoad: async () => {
    const session = await loadSession();
    if (session) throw redirect({ to: '/' });
  },
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/forgot-password',
  component: ForgotPasswordPage,
});

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/reset-password',
  component: ResetPasswordPage,
});

const acceptInviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/accept-invite',
  component: AcceptInvitePage,
});

const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: VERIFY_EMAIL_PAGE,
  component: VerifyEmailPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/login',
  component: LoginPage,
  beforeLoad: async ({ location }) => {
    const session = await loadSession();
    // Already signed in: straight on to the page the link asked for (#225).
    if (session) throw redirect({ href: returnPathFromSearch(location.searchStr) ?? '/' });
  },
});

// Loaded when needed: the second step and enrolment pages carry the QR code and WebAuthn
// code, which no other page needs (the initial JavaScript has a budget, check-route-chunks).
const TwoFactorPage = lazyRouteComponent(() => import('~/routes/auth/two-factor'), 'TwoFactorPage');
const MfaSetupPage = lazyRouteComponent(() => import('~/routes/auth/mfa-setup'), 'MfaSetupPage');

// The second step of a password sign-in (#399). Public: the person has no
// session until the code is accepted, and is sent on when they have one.
const twoFactorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: MFA_CHALLENGE_PATH,
  component: TwoFactorPage,
  beforeLoad: async ({ location }) => {
    const session = await loadSession();
    if (session) throw redirect({ href: returnPathFromSearch(location.searchStr) ?? '/' });
  },
});

// Where a limited person is sent (#399): outside the app shell, enrolment and
// sign-out only. Anyone not limited has nothing to do here.
const mfaSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: MFA_SETUP_PATH,
  component: MfaSetupPage,
  beforeLoad: async ({ location }) => {
    const session = await loadSession();
    if (!session)
      throw redirect({ to: '/auth/login', search: signInSearch(location.href) as never });
    if (!session.mfa?.limited) throw redirect({ to: '/', replace: true });
  },
});

const publicShareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/share/$slug',
  component: function PublicShareRoute() {
    const { slug } = publicShareRoute.useParams();
    return <PublicSharePage slug={slug} />;
  },
});

const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authenticated',
  beforeLoad: async ({ location }) => {
    // A verification link that did not work comes back to `/` (#329).
    const failed = failedVerificationCode(location.pathname, location.searchStr);
    if (failed) throw redirect({ href: `${VERIFY_EMAIL_PAGE}?error=${failed}`, replace: true });
    const session = await loadSession();
    // Sign-in comes back to this page afterwards (#225).
    if (!session)
      throw redirect({ to: '/auth/login', search: signInSearch(location.href) as never });
    sendLimitedToSetup(session);
    return { session };
  },
  component: () => (
    // Wraps the shell rather than sitting inside it, so a required policy is
    // not shown alongside a usable application. The second step comes first: a
    // limited session is refused the policy's own request too (#399).
    <MfaGate>
      <OnboardingGate>
        <AppShell>
          <Outlet />
        </AppShell>
      </OnboardingGate>
    </MfaGate>
  ),
  pendingComponent: FullPageSpinner,
});

const chatHomeRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/',
  validateSearch: validateChatHomeSearch,
  component: function ChatHomeRoute() {
    const { project } = chatHomeRoute.useSearch();
    // A fresh page for each New Chat, here or in another project (#208).
    const fresh = useNewChatKey();
    return <ChatHomePage key={`${project ?? ''}:${fresh}`} projectId={project} />;
  },
});

const ProjectPage = lazyRouteComponent(() => import('~/routes/projects/project'), 'ProjectPage');

const ProjectsPage = lazyRouteComponent(
  () => import('~/routes/projects/projects-list'),
  'ProjectsPage',
);

const projectsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects',
  component: ProjectsPage,
});

const projectRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/projects/$projectId',
  validateSearch: validateProjectSearch,
  component: function ProjectRoute() {
    const { projectId } = projectRoute.useParams();
    return <ProjectPage projectId={projectId} />;
  },
});

const chatThreadRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/chat/$threadId',
  validateSearch: validateChatThreadSearch,
  // The conversation this tab removed as it closed or reloaded, never used
  // (#266): a new chat with its unsent text, not "unavailable".
  beforeLoad: ({ params }) => redirectRemovedConversation(params.threadId),
  component: function ChatThreadRoute() {
    const { threadId } = chatThreadRoute.useParams();
    const { message } = chatThreadRoute.useSearch();
    // Changes on every navigation, so choosing the same result again re-centres it.
    const navigationKey = useRouterState({
      select: (state) => state.location.state.__TSR_key ?? state.location.href,
    });
    return (
      <ChatThreadPage
        threadId={threadId}
        target={message ? { messageId: message, key: navigationKey } : undefined}
      />
    );
  },
});

/**
 * Settings is a full-page surface: it replaces the chat shell rather than
 * rendering inside it, so the thread sidebar is hidden.
 */
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'settings',
  beforeLoad: async ({ location }) => {
    const session = await loadSession();
    if (!session)
      throw redirect({ to: '/auth/login', search: signInSearch(location.href) as never });
    sendLimitedToSetup(session);
    return { session };
  },
  component: lazyRouteComponent(
    () => import('~/components/settings/settings-layout'),
    'SettingsLayout',
  ),
  pendingComponent: FullPageSpinner,
});

const SETTINGS_TABS = [
  {
    path: '/settings',
    component: lazyRouteComponent(() => import('~/routes/settings/account'), 'SettingsAccountPage'),
  },
  {
    path: '/settings/customization',
    component: lazyRouteComponent(
      () => import('~/routes/settings/customization'),
      'SettingsCustomizationPage',
    ),
  },
  {
    path: '/settings/history',
    component: lazyRouteComponent(() => import('~/routes/settings/history'), 'SettingsHistoryPage'),
  },
  {
    path: '/settings/memory',
    component: lazyRouteComponent(() => import('~/routes/settings/memory'), 'SettingsMemoryPage'),
  },
  {
    path: '/settings/models',
    component: lazyRouteComponent(() => import('~/routes/settings/models'), 'SettingsModelsPage'),
  },
  {
    path: '/settings/sharing',
    component: lazyRouteComponent(() => import('~/routes/settings/sharing'), 'SettingsSharingPage'),
  },
  {
    path: '/settings/groups',
    component: lazyRouteComponent(() => import('~/routes/settings/groups'), 'SettingsGroupsPage'),
  },
  {
    path: '/settings/connectors',
    component: lazyRouteComponent(
      () => import('~/routes/settings/connectors'),
      'SettingsConnectorsPage',
    ),
  },
  {
    path: '/settings/attachments',
    component: lazyRouteComponent(
      () => import('~/routes/settings/attachments'),
      'SettingsAttachmentsPage',
    ),
  },
] as const;

/**
 * Shortcuts and Contact were tabs until v0.9.1; both now live in the cards
 * beside every settings page, so old links land on Settings.
 */
const retiredSettingsRoutes = ['/settings/shortcuts', '/settings/contact'].map((path) =>
  createRoute({
    getParentRoute: () => settingsRoute,
    path,
    beforeLoad: () => {
      throw redirect({ to: '/settings' });
    },
  }),
);

const settingsTabRoutes = SETTINGS_TABS.map((tab) =>
  createRoute({
    getParentRoute: () => settingsRoute,
    path: tab.path,
    component: tab.component,
  }),
);

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'admin',
  beforeLoad: async ({ location }) => {
    const session = await loadSession();
    if (!session)
      throw redirect({ to: '/auth/login', search: signInSearch(location.href) as never });
    // Auditors get read-only access: the API serves them GETs and rejects
    // writes, and the layout hides or disables every mutating control.
    if (session.user.role !== 'admin' && session.user.role !== 'auditor') {
      throw redirect({ to: '/' });
    }
    sendLimitedToSetup(session);
    return { session };
  },
  component: lazyRouteComponent(() => import('~/components/admin/admin-layout'), 'AdminLayout'),
  pendingComponent: FullPageSpinner,
  // "/admin/invitations" and the like: inside the admin chrome, with a way back (#131).
  notFoundComponent: () => <NotFoundPage admin />,
});

const adminOverviewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin',
  component: lazyRouteComponent(() => import('~/routes/admin/overview'), 'AdminOverviewPage'),
});

const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/users',
  validateSearch: validateUsersSearch,
  component: lazyRouteComponent(() => import('~/routes/admin/users'), 'AdminUsersPage'),
});

const adminGroupsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/groups',
  component: lazyRouteComponent(() => import('~/routes/admin/groups'), 'AdminGroupsPage'),
});

const adminGroupDetailRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/groups/$groupId',
  validateSearch: validateGroupSearch,
  component: lazyRouteComponent(
    () => import('~/routes/admin/group-detail'),
    'AdminGroupDetailPage',
  ),
});

const adminReportsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/reports',
  component: lazyRouteComponent(() => import('~/routes/admin/reports'), 'AdminReportsPage'),
});

const adminHealthRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/health',
  component: lazyRouteComponent(() => import('~/routes/admin/health'), 'AdminHealthPage'),
});

const adminUserDetailRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/users/$userId',
  component: lazyRouteComponent(() => import('~/routes/admin/user-detail'), 'AdminUserDetailPage'),
});

// Pages merged into another keep their old address working. Redirecting in
// beforeLoad means no page module is loaded for the old path.
type MergedAdminPage =
  | '/admin/models'
  | '/admin/settings/authentication'
  | '/admin/roles'
  | '/admin/health';

function redirectRoute<TPath extends string>(path: TPath, to: MergedAdminPage, hash?: string) {
  return createRoute({
    getParentRoute: () => adminRoute,
    path,
    beforeLoad: () => {
      throw redirect({ to, hash, replace: true });
    },
  });
}

// Providers is the default tab of Providers & Models.
const adminProvidersRoute = redirectRoute('/admin/providers', '/admin/models');
const adminSsoRoute = redirectRoute(
  '/admin/sso',
  '/admin/settings/authentication',
  'single-sign-on',
);
const adminRateLimitsRoute = redirectRoute('/admin/rate-limits', '/admin/roles');
const adminStorageLimitsRoute = redirectRoute('/admin/storage-limits', '/admin/roles');
const adminMaintenanceRoute = redirectRoute('/admin/maintenance', '/admin/health');

const adminRolesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/roles',
  validateSearch: validateRolesSearch,
  component: lazyRouteComponent(() => import('~/routes/admin/roles'), 'AdminRolesPage'),
});

const adminModelsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/models',
  validateSearch: validateModelsSearch,
  component: lazyRouteComponent(() => import('~/routes/admin/models'), 'AdminModelsPage'),
});

// Instance settings are three pages rather than in-page tabs, so each has a
// URL; the old address keeps working by landing on General.
const adminSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/settings',
  beforeLoad: () => {
    throw redirect({ to: '/admin/settings/general', replace: true });
  },
});

const adminGeneralSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/settings/general',
  component: lazyRouteComponent(
    () => import('~/routes/admin/settings'),
    'AdminGeneralSettingsPage',
  ),
});

const adminAuthenticationSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/settings/authentication',
  component: lazyRouteComponent(
    () => import('~/routes/admin/settings'),
    'AdminAuthenticationSettingsPage',
  ),
});

const adminEmailSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/settings/email',
  component: lazyRouteComponent(() => import('~/routes/admin/settings'), 'AdminEmailSettingsPage'),
});

const adminInvitesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/invites',
  component: lazyRouteComponent(() => import('~/routes/admin/invites'), 'AdminInvitesPage'),
});

const adminBrandingRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/branding',
  component: lazyRouteComponent(() => import('~/routes/admin/branding'), 'AdminBrandingPage'),
});

const adminQuotasRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/quotas',
  component: lazyRouteComponent(() => import('~/routes/admin/quotas'), 'AdminQuotasPage'),
});

const adminSearchRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/search',
  component: lazyRouteComponent(() => import('~/routes/admin/search'), 'AdminSearchPage'),
});

const adminConnectorsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/connectors',
  component: lazyRouteComponent(() => import('~/routes/admin/connectors'), 'AdminConnectorsPage'),
});

const adminDataClassesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/data-classes',
  component: lazyRouteComponent(
    () => import('~/routes/admin/data-classes'),
    'AdminDataClassesPage',
  ),
});

const adminStorageRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/storage',
  validateSearch: validateStorageSearch,
  component: lazyRouteComponent(() => import('~/routes/admin/storage'), 'AdminStoragePage'),
});

const adminWebhooksRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/webhooks',
  component: lazyRouteComponent(() => import('~/routes/admin/webhooks'), 'AdminWebhooksPage'),
});

const adminBackupsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/backups',
  component: lazyRouteComponent(() => import('~/routes/admin/backups'), 'AdminBackupsPage'),
});

const adminComplianceRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/compliance',
  component: lazyRouteComponent(() => import('~/routes/admin/compliance'), 'AdminCompliancePage'),
});

const adminRetentionRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/retention',
  component: lazyRouteComponent(() => import('~/routes/admin/retention'), 'AdminRetentionPage'),
});

const adminPoliciesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/policies',
  component: lazyRouteComponent(() => import('~/routes/admin/policies'), 'AdminPoliciesPage'),
});

const adminBroadcastsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/broadcasts',
  component: lazyRouteComponent(() => import('~/routes/admin/broadcasts'), 'AdminBroadcastsPage'),
});

const adminUsageRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/usage',
  validateSearch: validateUsageSearch,
  component: lazyRouteComponent(() => import('~/routes/admin/usage'), 'AdminUsagePage'),
});

const adminAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/audit',
  component: lazyRouteComponent(() => import('~/routes/admin/audit'), 'AdminAuditPage'),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  twoFactorRoute,
  mfaSetupRoute,
  signupRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  acceptInviteRoute,
  verifyEmailRoute,
  publicShareRoute,
  authenticatedRoute.addChildren([chatHomeRoute, chatThreadRoute, projectsRoute, projectRoute]),
  settingsRoute.addChildren([...settingsTabRoutes, ...retiredSettingsRoutes]),
  adminRoute.addChildren([
    adminOverviewRoute,
    adminUsersRoute,
    adminUserDetailRoute,
    adminGroupsRoute,
    adminGroupDetailRoute,
    adminHealthRoute,
    adminReportsRoute,
    adminProvidersRoute,
    adminModelsRoute,
    adminRolesRoute,
    adminSettingsRoute,
    adminGeneralSettingsRoute,
    adminAuthenticationSettingsRoute,
    adminEmailSettingsRoute,
    adminInvitesRoute,
    adminBrandingRoute,
    adminSsoRoute,
    adminQuotasRoute,
    adminSearchRoute,
    adminConnectorsRoute,
    adminDataClassesRoute,
    adminWebhooksRoute,
    adminBackupsRoute,
    adminComplianceRoute,
    adminStorageRoute,
    adminStorageLimitsRoute,
    adminRateLimitsRoute,
    adminRetentionRoute,
    adminPoliciesRoute,
    adminBroadcastsRoute,
    adminUsageRoute,
    adminMaintenanceRoute,
    adminAuditRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: FullPageSpinner,
  defaultErrorComponent: RouteLoadError,
  // Inside a layout (the chat shell, settings): its page area says so (#131).
  defaultNotFoundComponent: () => <NotFoundPage />,
});

/**
 * A session ended while the app was open (a ban, Sign out everywhere): leave
 * the stale page for sign-in, which says the person was signed out (#165).
 * The public pages need no session.
 */
onSessionEnded(() => {
  confirmedSession = null;
  const { pathname, href } = router.state.location;
  if (pathname.startsWith('/auth/') || pathname.startsWith('/share/')) return;
  // Signing in again comes back to the page that was open (#225). The flag is
  // a number: the router writes a string that reads as JSON in quotes, so '1'
  // showed as `?signed-out=%221%22` in the address bar (#237).
  void router.navigate({
    to: '/auth/login',
    search: { [SIGNED_OUT_PARAM]: 1, ...signInSearch(href) } as never,
  });
});

/**
 * The requirement started while the app was open (a role added with no grace):
 * a request was refused with 403 MFA_ENROLMENT_REQUIRED. Wherever the person is
 * (the shell's MfaGate looks again, but settings and administration have no such
 * gate), go to the setup page (#399). The page itself and the other sign-in
 * pages stay where they are.
 */
onMfaRequired(() => {
  const { pathname } = router.state.location;
  if (pathname.startsWith('/auth/') || pathname.startsWith('/share/')) return;
  confirmedSession = null;
  void router.navigate({ to: MFA_SETUP_PATH, replace: true });
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
