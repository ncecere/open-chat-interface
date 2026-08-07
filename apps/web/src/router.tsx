import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AdminLayout } from '~/components/admin/admin-layout';
import { AppShell } from '~/components/layout/app-shell';
import { FullPageSpinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';
import { AdminModelsPage } from '~/routes/admin/models';
import { AdminOverviewPage } from '~/routes/admin/overview';
import { AdminPlaceholderPage } from '~/routes/admin/placeholder';
import { AdminProvidersPage } from '~/routes/admin/providers';
import { AdminUsersPage } from '~/routes/admin/users';
import { LoginPage } from '~/routes/auth/login';
import { ChatHomePage } from '~/routes/chat/home';
import { ChatThreadPage } from '~/routes/chat/thread';
import { SettingsPage } from '~/routes/settings/settings';

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

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/login',
  component: LoginPage,
  beforeLoad: async () => {
    const session = await loadSession();
    if (session) throw redirect({ to: '/' });
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

const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/settings',
  component: SettingsPage,
});

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

const ADMIN_STUBS = [
  { path: '/admin/settings', title: 'Settings', description: 'Instance-wide configuration.' },
  { path: '/admin/branding', title: 'Branding', description: 'Name, logo, and accent color.' },
  {
    path: '/admin/invites',
    title: 'Invitations',
    description: 'Generate and revoke invite links.',
  },
  { path: '/admin/sso', title: 'Auth & SSO', description: 'Local auth, OIDC, and SAML providers.' },
  { path: '/admin/quotas', title: 'Quotas & limits', description: 'Per-role usage limits.' },
  { path: '/admin/search', title: 'Search', description: 'Web search grounding provider.' },
  {
    path: '/admin/storage',
    title: 'Storage',
    description: 'Attachment storage driver and limits.',
  },
  { path: '/admin/audit', title: 'Audit log', description: 'Administrative and security events.' },
] as const;

const adminStubRoutes = ADMIN_STUBS.map((stub) =>
  createRoute({
    getParentRoute: () => adminRoute,
    path: stub.path,
    component: () => <AdminPlaceholderPage title={stub.title} description={stub.description} />,
  }),
);

const routeTree = rootRoute.addChildren([
  loginRoute,
  authenticatedRoute.addChildren([chatHomeRoute, chatThreadRoute, settingsRoute]),
  adminRoute.addChildren([
    adminOverviewRoute,
    adminUsersRoute,
    adminProvidersRoute,
    adminModelsRoute,
    ...adminStubRoutes,
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
