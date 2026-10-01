import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from '~/components/layout/app-shell';
import { OnboardingGate } from '~/components/onboarding/onboarding-gate';
import { RouteLoadError } from '~/components/ui/route-load-error';
import { FullPageSpinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';
import { AcceptInvitePage } from '~/routes/auth/accept-invite';
import { LoginPage } from '~/routes/auth/login';
import { ForgotPasswordPage, ResetPasswordPage } from '~/routes/auth/password-reset';
import { SignupPage } from '~/routes/auth/signup';
import { ChatHomePage } from '~/routes/chat/home';
import { ChatThreadPage } from '~/routes/chat/thread';
import { PublicSharePage } from '~/routes/share/public-share';

interface SessionSnapshot {
  user: { id: string; role: string };
}

/** Route guards read the session directly so redirects happen before render. */
async function loadSession(): Promise<SessionSnapshot | null> {
  try {
    return await api.get<SessionSnapshot>('/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

const rootRoute = createRootRoute({
  component: Outlet,
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

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/login',
  component: LoginPage,
  beforeLoad: async () => {
    const session = await loadSession();
    if (session) throw redirect({ to: '/' });
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
  beforeLoad: async () => {
    const session = await loadSession();
    if (!session) throw redirect({ to: '/auth/login' });
    return { session };
  },
  component: () => (
    // Wraps the shell rather than sitting inside it, so a required policy is
    // not shown alongside a usable application.
    <OnboardingGate>
      <AppShell>
        <Outlet />
      </AppShell>
    </OnboardingGate>
  ),
  pendingComponent: FullPageSpinner,
});

const chatHomeRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/',
  component: ChatHomePage,
});

const chatThreadRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/chat/$threadId',
  component: function ChatThreadRoute() {
    const { threadId } = chatThreadRoute.useParams();
    return <ChatThreadPage threadId={threadId} />;
  },
});

/**
 * Settings is a full-page surface: it replaces the chat shell rather than
 * rendering inside it, so the thread sidebar is hidden.
 */
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'settings',
  beforeLoad: async () => {
    const session = await loadSession();
    if (!session) throw redirect({ to: '/auth/login' });
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
    path: '/settings/models',
    component: lazyRouteComponent(() => import('~/routes/settings/models'), 'SettingsModelsPage'),
  },
  {
    path: '/settings/attachments',
    component: lazyRouteComponent(
      () => import('~/routes/settings/attachments'),
      'SettingsAttachmentsPage',
    ),
  },
  {
    path: '/settings/shortcuts',
    component: lazyRouteComponent(
      () => import('~/routes/settings/simple-tabs'),
      'SettingsShortcutsPage',
    ),
  },
  {
    path: '/settings/contact',
    component: lazyRouteComponent(
      () => import('~/routes/settings/simple-tabs'),
      'SettingsContactPage',
    ),
  },
] as const;

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
  beforeLoad: async () => {
    const session = await loadSession();
    if (!session) throw redirect({ to: '/auth/login' });
    if (session.user.role !== 'admin') throw redirect({ to: '/' });
    return { session };
  },
  component: lazyRouteComponent(() => import('~/components/admin/admin-layout'), 'AdminLayout'),
  pendingComponent: FullPageSpinner,
});

const adminOverviewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin',
  component: lazyRouteComponent(() => import('~/routes/admin/overview'), 'AdminOverviewPage'),
});

const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/users',
  component: lazyRouteComponent(() => import('~/routes/admin/users'), 'AdminUsersPage'),
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

const adminProvidersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/providers',
  component: lazyRouteComponent(() => import('~/routes/admin/providers'), 'AdminProvidersPage'),
});

const adminModelsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/models',
  component: lazyRouteComponent(() => import('~/routes/admin/models'), 'AdminModelsPage'),
});

const adminSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/settings',
  component: lazyRouteComponent(() => import('~/routes/admin/settings'), 'AdminSettingsPage'),
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

const adminSsoRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/sso',
  component: lazyRouteComponent(() => import('~/routes/admin/sso'), 'AdminSsoPage'),
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

const adminStorageRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/storage',
  component: lazyRouteComponent(() => import('~/routes/admin/storage'), 'AdminStoragePage'),
});

const adminStorageLimitsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/storage-limits',
  component: lazyRouteComponent(
    () => import('~/routes/admin/storage-limits'),
    'AdminStorageLimitsPage',
  ),
});

const adminRateLimitsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/rate-limits',
  component: lazyRouteComponent(() => import('~/routes/admin/rate-limits'), 'AdminRateLimitsPage'),
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
  component: lazyRouteComponent(() => import('~/routes/admin/usage'), 'AdminUsagePage'),
});

const adminMaintenanceRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/maintenance',
  component: lazyRouteComponent(() => import('~/routes/admin/maintenance'), 'AdminMaintenancePage'),
});

const adminAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/audit',
  component: lazyRouteComponent(() => import('~/routes/admin/audit'), 'AdminAuditPage'),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  signupRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  acceptInviteRoute,
  publicShareRoute,
  authenticatedRoute.addChildren([chatHomeRoute, chatThreadRoute]),
  settingsRoute.addChildren(settingsTabRoutes),
  adminRoute.addChildren([
    adminOverviewRoute,
    adminUsersRoute,
    adminUserDetailRoute,
    adminHealthRoute,
    adminReportsRoute,
    adminProvidersRoute,
    adminModelsRoute,
    adminSettingsRoute,
    adminInvitesRoute,
    adminBrandingRoute,
    adminSsoRoute,
    adminQuotasRoute,
    adminSearchRoute,
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
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
