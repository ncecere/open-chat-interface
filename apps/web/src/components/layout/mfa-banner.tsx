import { Link } from '@tanstack/react-router';
import { ShieldAlert } from 'lucide-react';
import { useCurrentUser } from '~/hooks/use-current-user';
import { mfaDeadlineText } from '~/lib/mfa';
import { cn } from '~/lib/utils';

/**
 * Before the deadline, above the page: the person's role requires two-step
 * verification and they have not set it up (#399). Once the deadline has
 * passed they are limited and sent to the setup page instead, so this is only
 * the reminder. Not dismissable: it goes when they set it up.
 */
export function MfaBanner({ className }: { className?: string }) {
  const { data } = useCurrentUser();
  const mfa = data?.mfa;
  if (!mfa?.required || mfa.limited || mfa.enrolled || !mfa.deadline) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 border-b border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-2.5 text-sm',
        className,
      )}
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      <p className="min-w-0 flex-1 leading-relaxed text-[var(--text-secondary)]">
        Set up two-step verification by {mfaDeadlineText(mfa.deadline)}.{' '}
        <Link to="/settings" className="font-medium text-[var(--accent-bright)] hover:underline">
          Set up now
        </Link>
      </p>
    </div>
  );
}
