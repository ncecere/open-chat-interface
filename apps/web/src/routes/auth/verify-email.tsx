import { Link, useRouterState } from '@tanstack/react-router';
import { MailWarning } from 'lucide-react';
import { useState } from 'react';
import { ResendVerification } from '~/components/auth/resend-verification';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { verifyLinkProblem } from '~/lib/verify-email-link';
import { AuthCard } from './password-reset';

/**
 * An email-verification link that did not work (#329): what happened and
 * how to get a new one, as the reset page does for a bad reset link. It
 * landed on the sign-in page, or the home page, with no word about it.
 */
export function VerifyEmailPage() {
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const code = new URLSearchParams(searchStr).get('error');
  const [email, setEmail] = useState('');
  const problem = verifyLinkProblem(code);

  return (
    <AuthCard>
      <div className="space-y-4 text-center">
        <MailWarning className="mx-auto size-8 text-[var(--text-muted)]" aria-hidden="true" />
        <h1 className="text-lg font-semibold">{problem.title}</h1>
        <p className="text-sm text-[var(--text-muted)]">
          {problem.message} Sign in with your email and password and we will send you a new link, or
          ask for one here.
        </p>
        <Button asChild variant="primary" className="w-full">
          <Link to="/auth/login">Sign in</Link>
        </Button>
        <div className="flex flex-col gap-1.5 text-left">
          <Label htmlFor="verify-email-address">Email</Label>
          <Input
            id="verify-email-address"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <ResendVerification email={email} emailFieldId="verify-email-address" />
      </div>
    </AuthCard>
  );
}
