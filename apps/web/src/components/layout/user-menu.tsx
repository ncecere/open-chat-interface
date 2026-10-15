import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { LogOut, Settings, Shield } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { useCurrentUser } from '~/hooks/use-current-user';
import { authClient } from '~/lib/auth-client';
import { type MessageKey, useT } from '~/lib/i18n';
import { cn } from '~/lib/utils';

/** The role as a person reads it; one that has no entry is shown as the server names it. */
const ROLE_LABELS: Record<string, MessageKey> = {
  admin: 'shell.userMenu.roleAdmin',
  auditor: 'shell.userMenu.roleAuditor',
  user: 'shell.userMenu.roleUser',
  restricted: 'shell.userMenu.roleRestricted',
};

export function UserMenu({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const { data } = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  if (!data) return null;

  const { user } = data;
  const initials = user.name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  async function handleSignOut() {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: '/auth/login' });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={compact ? t('shell.userMenu.open') : undefined}
        className={cn(
          'flex items-center gap-3 rounded-lg text-start transition-colors hover:bg-[var(--bg-control)]',
          compact ? 'rounded-full p-1' : 'w-full px-2 py-2',
        )}
      >
        {user.image ? (
          <img
            src={user.image}
            alt=""
            className={cn('rounded-full object-cover', compact ? 'size-10' : 'size-8')}
          />
        ) : (
          <span
            className={cn(
              'flex items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-[var(--accent-foreground)]',
              compact ? 'size-10' : 'size-8',
            )}
          >
            {initials}
          </span>
        )}
        <span className={cn('min-w-0 flex-1', compact && 'hidden')}>
          <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
            {user.name}
          </span>
          <span className="block truncate text-xs text-[var(--text-muted)]">
            {ROLE_LABELS[user.role] ? t(ROLE_LABELS[user.role] as MessageKey) : user.role}
          </span>
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-56">
        {user.role === 'admin' && (
          <>
            <DropdownMenuItem asChild>
              <Link to="/admin">
                <Shield />
                {t('shell.userMenu.adminDashboard')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings />
            {t('shell.userMenu.settings')}
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={handleSignOut}>
          <LogOut className="rtl:-scale-x-100" />
          {t('shell.userMenu.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
