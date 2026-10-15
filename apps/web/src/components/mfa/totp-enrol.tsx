import type { EnableTotpResponse, RecoveryCodesResponse } from '@oci/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Smartphone } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { QrCode } from '~/components/mfa/qr-code';
import { RecoveryCodes } from '~/components/mfa/recovery-codes';
import { Button } from '~/components/ui/button';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { problemsAt, problemsElsewhere, useFieldProblems } from '~/hooks/use-clear-on-edit';
import { ApiError, api } from '~/lib/api-client';
import { authenticatorCode, groupManualKey, MFA_STATUS_KEY, mfaProblems } from '~/lib/mfa';
import { useReadOnlyLock } from '~/lib/read-only';

type Step =
  | { name: 'password' }
  | { name: 'scan'; totpURI: string; manualKey: string }
  // Held here, in state, and nowhere else (#399).
  | { name: 'codes'; recoveryCodes: string[] };

/** Where focus goes when a step replaces the control that had it. */
function StepHeading({ children }: { children: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <h4 ref={ref} tabIndex={-1} className="text-sm font-semibold outline-none">
      {children}
    </h4>
  );
}

/**
 * Setting up an authenticator app, step by step (#399): the password, then a QR
 * code (with the key to type and the link for a phone, so it works without a
 * camera, WCAG 2.2 SC 3.3.8) and a confirming code, then the recovery codes,
 * once. The secret is live on the server only when a code is confirmed.
 */
export function TotpEnrol({
  onCancel,
  onFinished,
}: {
  onCancel: () => void;
  /** The recovery codes were saved and Done pressed. */
  onFinished: () => void;
}) {
  const queryClient = useQueryClient();
  const lock = useReadOnlyLock();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState<Step>({ name: 'password' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [problems, setProblems] = useFieldProblems({ password, code }, form);

  async function begin(event: FormEvent) {
    event.preventDefault();
    if (!password) {
      setProblems([{ fields: ['password'], text: 'Enter your password.' }]);
      form.current?.querySelector<HTMLElement>('input')?.focus();
      return;
    }
    setBusy(true);
    try {
      const started = await api.post<EnableTotpResponse>('/me/mfa/totp', { password });
      setPassword('');
      setCode('');
      setProblems([]);
      setStep({ name: 'scan', totpURI: started.totpURI, manualKey: started.manualKey });
    } catch (error) {
      setProblems(mfaProblems(error, 'Two-step verification could not be started. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!code.trim()) {
      setProblems([{ fields: ['code'], text: 'Enter the code your authenticator app shows.' }]);
      form.current?.querySelector<HTMLElement>('input')?.focus();
      return;
    }
    setBusy(true);
    try {
      const confirmed = await api.post<RecoveryCodesResponse>('/me/mfa/totp/confirm', {
        code: authenticatorCode(code),
      });
      setCode('');
      setProblems([]);
      setStep({ name: 'codes', recoveryCodes: confirmed.recoveryCodes });
      // Confirming replaced the session and turned the second step on: what
      // /api/me and the settings page say has changed.
      void queryClient.invalidateQueries({ queryKey: ['me'], exact: true });
      void queryClient.invalidateQueries({ queryKey: MFA_STATUS_KEY });
    } catch (error) {
      const found = mfaProblems(error, 'The code could not be checked. Try again.');
      // Nothing waiting to be confirmed (409): the secret is gone, so start over.
      // (The typed code stays: editing it would clear this message.)
      if (error instanceof ApiError && error.status === 409) setStep({ name: 'password' });
      setProblems(found);
    } finally {
      setBusy(false);
    }
  }

  async function copyKey(manualKey: string) {
    try {
      await navigator.clipboard.writeText(manualKey);
      setCopiedKey(true);
    } catch {
      setCopiedKey(false);
    }
  }

  if (step.name === 'codes') {
    return <RecoveryCodes codes={step.recoveryCodes} onDone={onFinished} />;
  }

  const passwordId = `${id}-password`;
  const codeId = `${id}-code`;
  const elsewhere = problemsElsewhere(problems, ['password', 'code']);

  if (step.name === 'password') {
    return (
      <form ref={form} onSubmit={begin} noValidate className="flex max-w-sm flex-col gap-4">
        <div>
          <StepHeading>Set up an authenticator app</StepHeading>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Enter your password to start. Then you will scan a QR code with an authenticator app on
            your phone, or type its key by hand.
          </p>
        </div>
        <Field
          label="Current password"
          htmlFor={passwordId}
          error={problemsAt(problems, 'password')}
        >
          <Input
            id={passwordId}
            {...invalidFieldProps(passwordId, problemsAt(problems, 'password'))}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {elsewhere && (
          <p role="alert" className="whitespace-pre-line text-sm text-[var(--danger)]">
            {elsewhere}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" locked={lock.title} disabled={busy}>
            {busy && <Spinner />}
            Continue
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form ref={form} onSubmit={confirm} noValidate className="flex flex-col gap-5">
      <div>
        <StepHeading>Scan the QR code</StepHeading>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Scan it with an authenticator app, such as one from your phone's app store or a password
          manager. Then enter the 6-digit code it shows.
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <div className="shrink-0 rounded-xl bg-white p-1">
          <QrCode value={step.totpURI} />
        </div>
        <div className="flex min-w-0 max-w-sm flex-col gap-3">
          <div>
            <p className="text-sm font-medium text-[var(--text-secondary)]">
              Cannot scan it? Enter this key in your app
            </p>
            <p
              data-testid="manual-key"
              className="mt-1 select-all break-all font-mono text-sm tracking-wider text-[var(--text-primary)]"
            >
              {groupManualKey(step.manualKey)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => copyKey(step.manualKey)}
              >
                <Copy />
                Copy key
              </Button>
              <p role="status" className="text-xs text-[var(--text-muted)]">
                {copiedKey && 'Key copied to the clipboard.'}
              </p>
            </div>
          </div>
          <a
            href={step.totpURI}
            className="inline-flex items-center gap-1.5 text-sm text-[var(--accent-bright)] hover:underline"
          >
            <Smartphone className="size-4" aria-hidden="true" />
            Open in your authenticator app
          </a>
        </div>
      </div>

      <div className="max-w-sm">
        <Field
          label="Authentication code"
          htmlFor={codeId}
          error={problemsAt(problems, 'code')}
          hint="The 6-digit code from your app. You can paste it; spaces are fine."
        >
          <Input
            id={codeId}
            {...invalidFieldProps(codeId, problemsAt(problems, 'code'))}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </Field>
      </div>

      {elsewhere && (
        <p role="alert" className="whitespace-pre-line text-sm text-[var(--danger)]">
          {elsewhere}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="accent" locked={lock.title} disabled={busy}>
          {busy && <Spinner />}
          Turn on
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
