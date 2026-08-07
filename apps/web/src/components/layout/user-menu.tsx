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

export function UserMenu() {
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
      <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--bg-control)]">
        {user.image ? (
          <img src={user.image} alt="" className="size-8 rounded-full object-cover" />
        ) : (
          <span className="flex size-8 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-[var(--accent-foreground)]">
            {initials}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--text-primary)]">
            {user.name}
          </span>
          <span className="block truncate text-xs capitalize text-[var(--text-muted)]">
            {user.role}
          </span>
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-56">
        {user.role === 'admin' && (
          <>
            <DropdownMenuItem asChild>
              <Link to="/admin">
                <Shield />
                Admin dashboard
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings />
            Settings
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={handleSignOut}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
