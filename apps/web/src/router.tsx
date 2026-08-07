import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AdminLayout } from '~/components/admin/admin-layout';
import { AppShell } from '~/components/layout/app-shell';
import { SettingsLayout } from '~/components/settings/settings-layout';
import { FullPageSpinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';
import { AdminAuditPage } from '~/routes/admin/audit';
import { AdminBrandingPage } from '~/routes/admin/branding';
import { AdminInvitesPage } from '~/routes/admin/invites';
import { AdminModelsPage } from '~/routes/admin/models';
import { AdminOverviewPage } from '~/routes/admin/overview';
import { AdminProvidersPage } from '~/routes/admin/providers';
import { AdminQuotasPage } from '~/routes/admin/quotas';
import { AdminSearchPage } from '~/routes/admin/search';
import { AdminSettingsPage } from '~/routes/admin/settings';
import { AdminSsoPage } from '~/routes/admin/sso';
import { AdminStoragePage } from '~/routes/admin/storage';
import { AdminUsersPage } from '~/routes/admin/users';
import { AcceptInvitePage } from '~/routes/auth/accept-invite';
import { LoginPage } from '~/routes/auth/login';
import { ForgotPasswordPage, ResetPasswordPage } from '~/routes/auth/password-reset';
import { SignupPage } from '~/routes/auth/signup';
import { ChatHomePage } from '~/routes/chat/home';
import { ChatThreadPage } from '~/routes/chat/thread';
import { SettingsAccountPage } from '~/routes/settings/account';
import { SettingsAttachmentsPage } from '~/routes/settings/attachments';
import { SettingsCustomizationPage } from '~/routes/settings/customization';
import { SettingsHistoryPage } from '~/routes/settings/history';
import { SettingsModelsPage } from '~/routes/settings/models';
import { SettingsContactPage, SettingsShortcutsPage } from '~/routes/settings/simple-tabs';
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
    <AppShell>
      <Outlet />
    </AppShell>
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
  component: () => (
    <SettingsLayout>
      <Outlet />
    </SettingsLayout>
  ),
  pendingComponent: FullPageSpinner,
});

const SETTINGS_TABS = [
  { path: '/settings', component: SettingsAccountPage },
  { path: '/settings/customization', component: SettingsCustomizationPage },
  { path: '/settings/history', component: SettingsHistoryPage },
  { path: '/settings/models', component: SettingsModelsPage },
  { path: '/settings/attachments', component: SettingsAttachmentsPage },
  { path: '/settings/shortcuts', component: SettingsShortcutsPage },
  { path: '/settings/contact', component: SettingsContactPage },
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
  component: () => (
    <AdminLayout>
      <Outlet />
    </AdminLayout>
  ),
  pendingComponent: FullPageSpinner,
});

const adminOverviewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin',
  component: AdminOverviewPage,
});

const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/users',
  component: AdminUsersPage,
});

const adminProvidersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/providers',
  component: AdminProvidersPage,
});

const adminModelsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/models',
  component: AdminModelsPage,
});

const adminSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/settings',
  component: AdminSettingsPage,
});

const adminInvitesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/invites',
  component: AdminInvitesPage,
});

const adminBrandingRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/branding',
  component: AdminBrandingPage,
});

const adminSsoRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/sso',
  component: AdminSsoPage,
});

const adminQuotasRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/quotas',
  component: AdminQuotasPage,
});

const adminSearchRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/search',
  component: AdminSearchPage,
});

const adminStorageRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/storage',
  component: AdminStoragePage,
});

const adminAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: '/admin/audit',
  component: AdminAuditPage,
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
    adminProvidersRoute,
    adminModelsRoute,
    adminSettingsRoute,
    adminInvitesRoute,
    adminBrandingRoute,
    adminSsoRoute,
    adminQuotasRoute,
    adminSearchRoute,
    adminStorageRoute,
    adminAuditRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPendingComponent: FullPageSpinner,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
