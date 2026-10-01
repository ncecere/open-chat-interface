import {
  Activity,
  Archive,
  Boxes,
  ChartColumn,
  Cpu,
  FileText,
  Gauge,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  Mail,
  Mails,
  Megaphone,
  Palette,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Timer,
  Users,
  Wrench,
} from 'lucide-react';

// Shared by the sidebar and command palette without importing the admin layout.
export const NAV_SECTIONS = [
  {
    label: 'Instance',
    items: [
      { to: '/admin', label: 'Overview', icon: LayoutDashboard, exact: true },
      { to: '/admin/settings', label: 'Settings', icon: Settings },
      { to: '/admin/branding', label: 'Branding', icon: Palette },
      { to: '/admin/broadcasts', label: 'Announcements', icon: Megaphone },
    ],
  },
  {
    label: 'People',
    items: [
      { to: '/admin/users', label: 'Users', icon: Users },
      { to: '/admin/invites', label: 'Invitations', icon: Mail },
      { to: '/admin/sso', label: 'Auth & SSO', icon: ShieldCheck },
      { to: '/admin/policies', label: 'Acceptable use', icon: FileText },
    ],
  },
  {
    label: 'Models',
    items: [
      { to: '/admin/providers', label: 'Providers & Keys', icon: KeyRound },
      { to: '/admin/models', label: 'Model catalog', icon: Cpu },
    ],
  },
  // Allowances belong in Governance; provider/storage wiring lives in Platform.
  {
    label: 'Governance',
    items: [
      { to: '/admin/usage', label: 'Usage', icon: ChartColumn },
      { to: '/admin/reports', label: 'Reports', icon: Mails },
      { to: '/admin/quotas', label: 'Usage quotas', icon: Gauge },
      { to: '/admin/storage-limits', label: 'Storage limits', icon: HardDrive },
      { to: '/admin/rate-limits', label: 'Rate limits', icon: Timer },
      { to: '/admin/retention', label: 'Retention', icon: Archive },
    ],
  },
  {
    label: 'Platform',
    items: [
      { to: '/admin/search', label: 'Search', icon: Search },
      { to: '/admin/storage', label: 'Storage', icon: Boxes },
      { to: '/admin/health', label: 'Health', icon: Activity },
      { to: '/admin/maintenance', label: 'Maintenance', icon: Wrench },
      { to: '/admin/audit', label: 'Audit log', icon: ScrollText },
    ],
  },
] as const;
