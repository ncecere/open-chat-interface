import {
  MFA_MAX_GRACE_DAYS,
  type MfaImpact,
  type MfaRequirement,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Notice, SaveRow, SettingsSection } from '~/components/admin/admin-ui';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { ROLE_LABELS } from '~/components/admin/user-role-select';
import { Button } from '~/components/ui/button';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { ApiError, api, apiErrorMessage } from '~/lib/api-client';
import { mfaDeadlineText } from '~/lib/mfa';

export const MFA_IMPACT_KEY = ['admin', 'settings', 'mfa-impact'] as const;

const GRACE_PROBLEM = `Enter a whole number of days from 0 to ${MFA_MAX_GRACE_DAYS}.`;

/** The typed grace as a number of days, or null when it is not a whole number in range. */
export function graceDays(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const days = Number(text);
  return days <= MFA_MAX_GRACE_DAYS ? days : null;
}

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * The server's reasons for refusing to save a requirement (409
 * MFA_REQUIRED_FOR_ACTOR, `details.reason`), in the words the person needs to
 * get unstuck: both are fixed under Settings → Account.
 */
function refusalText(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'MFA_REQUIRED_FOR_ACTOR') return null;
  const reason = (error.details as { reason?: string } | undefined)?.reason;
  if (reason === 'no_enrolled_admin')
    return 'Administrators cannot be required to use two-step verification until at least one local administrator has set it up.';
  if (reason === 'actor_not_satisfied')
    return 'To require two-step verification you must have used it yourself in this session. Set it up, sign in with it, then save again.';
  return error.message;
}

/** What saving would do, from the figures and the form: who is limited, and when. */
function summary(
  impact: MfaImpact | undefined,
  roles: UserRole[],
  grace: number | null,
): string | null {
  if (roles.length === 0) return 'No role is required, so nobody is limited.';
  if (!impact) return null;
  const limited = impact.roles
    .filter((row) => roles.includes(row.role))
    .reduce((sum, row) => sum + row.unenrolled, 0);
  if (limited === 0)
    return 'Nobody would be limited: everyone in these roles has a second step, or signs in only through single sign-on.';
  if (grace === null) return null;
  const when = grace === 0 ? 'at their next request' : `after ${plural(grace, 'day', 'days')}`;
  return `${plural(limited, 'person', 'people')} would be limited ${when}, unless they set up two-step verification first.`;
}

function ImpactTable({ impact }: { impact: MfaImpact }) {
  return (
    <section
      // Scrolls sideways when narrow; keyboard users must reach it (WCAG 2.1.1).
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region needs keyboard access
      tabIndex={0}
      aria-label="Two-step verification by role"
      className="overflow-x-auto rounded-xl border border-[var(--border-subtle)]"
    >
      <table className="w-full min-w-[34rem] text-sm">
        <caption className="sr-only">
          How many people in each role have two-step verification set up
        </caption>
        <thead className="bg-[var(--bg-control-alt)] text-xs text-[var(--text-muted)]">
          <tr>
            <th scope="col" className="px-4 py-2 text-start font-medium">
              Role
            </th>
            <th scope="col" className="px-4 py-2 text-end font-medium">
              People
            </th>
            <th scope="col" className="px-4 py-2 text-end font-medium">
              Sign in only through SSO
            </th>
            <th scope="col" className="px-4 py-2 text-end font-medium">
              Set up
            </th>
            <th scope="col" className="px-4 py-2 text-end font-medium">
              Not set up
            </th>
            <th scope="col" className="px-4 py-2 text-end font-medium">
              Limited now
            </th>
          </tr>
        </thead>
        <tbody>
          {impact.roles.map((row) => (
            <tr key={row.role} className="border-t border-[var(--border-subtle)]">
              <th scope="row" className="px-4 py-2 text-start font-medium">
                {ROLE_LABELS[row.role]}
              </th>
              <td className="px-4 py-2 text-end tabular-nums">{row.people}</td>
              <td className="px-4 py-2 text-end tabular-nums">{row.exempt}</td>
              <td className="px-4 py-2 text-end tabular-nums">{row.enrolled}</td>
              <td className="px-4 py-2 text-end tabular-nums">{row.unenrolled}</td>
              <td className="px-4 py-2 text-end tabular-nums">
                {row.limitedNow}
                {row.firstDeadline && (
                  <span className="block text-xs font-normal text-[var(--text-muted)]">
                    First deadline: {mfaDeadlineText(row.firstDeadline)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Requiring two-step verification per role (#399), on Authentication settings.
 * Turning it on limits people who have no second step once the grace has passed:
 * they can then only set one up or sign out. So the figures come first: who each
 * role has, who has set it up, and how many would be limited by what is on the
 * form now. Saving a requirement is refused unless the administrator has used a
 * second step in this session, so they cannot switch on what they cannot do.
 */
export function MfaRequirementSection({ requirement }: { requirement: MfaRequirement }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState({
    roles: requirement.roles,
    graceDays: requirement.graceDays,
  });
  const [roles, setRoles] = useState<UserRole[]>(requirement.roles);
  const [graceText, setGraceText] = useState(String(requirement.graceDays));
  const [graceError, setGraceError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState(false);

  const figures = useQuery({
    queryKey: MFA_IMPACT_KEY,
    queryFn: () => api.get<MfaImpact>('/admin/settings/mfa-impact'),
    retry: false,
  });

  const grace = graceDays(graceText);
  const sameRoles =
    roles.length === saved.roles.length && roles.every((role) => saved.roles.includes(role));
  const hasChanges = !sameRoles || graceText.trim() !== String(saved.graceDays);
  useReportUnsaved(hasChanges);

  const save = useMutation({
    mutationFn: (input: { roles: UserRole[]; graceDays: number }) =>
      api.patch<{ ok: boolean }>('/admin/settings', { mfaRequirement: input }),
    onSuccess: (_response, input) => {
      setSaved(input);
      setSavedMessage(true);
      // The server stamped `since` for the roles added; the figures and settings are read again.
      void queryClient.invalidateQueries({ queryKey: MFA_IMPACT_KEY });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'], exact: true });
      void queryClient.invalidateQueries({ queryKey: ['me'], exact: true });
    },
    onError: () => setSavedMessage(false),
  });

  function edit() {
    setSavedMessage(false);
    setGraceError(null);
    save.reset();
  }

  function toggle(role: UserRole, on: boolean) {
    edit();
    setRoles((current) => USER_ROLES.filter((r) => (r === role ? on : current.includes(r))));
  }

  const refusal = refusalText(save.error);
  const message = summary(figures.data, roles, grace);

  return (
    <SettingsSection
      title="Two-step verification"
      description="Require people who sign in with a password to set up a second step: an authenticator app or a passkey. People who sign in only through single sign-on are never required; their identity provider enforces its own."
    >
      <form
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (grace === null) {
            setGraceError(GRACE_PROBLEM);
            document.getElementById('mfa-grace-days')?.focus();
            return;
          }
          if (hasChanges) save.mutate({ roles, graceDays: grace });
        }}
      >
        <fieldset className="min-w-0">
          <legend className="text-sm font-medium text-[var(--text-secondary)]">Required for</legend>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
            {USER_ROLES.map((role) => (
              <label
                key={role}
                htmlFor={`mfa-role-${role}`}
                className="flex items-center gap-2 text-sm text-[var(--text-secondary)]"
              >
                <input
                  id={`mfa-role-${role}`}
                  type="checkbox"
                  checked={roles.includes(role)}
                  onChange={(event) => toggle(role, event.target.checked)}
                  className="size-4 accent-[var(--accent)]"
                />
                {ROLE_LABELS[role]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="max-w-xs">
          <Field
            label="Grace period (days)"
            htmlFor="mfa-grace-days"
            error={graceError}
            hint="Days people have to set it up before they are limited, counted from when their role is required or their account is created, whichever is later. 0 limits people at their next request."
          >
            <Input
              id="mfa-grace-days"
              {...invalidFieldProps('mfa-grace-days', graceError)}
              type="number"
              min={0}
              max={MFA_MAX_GRACE_DAYS}
              step={1}
              inputMode="numeric"
              value={graceText}
              onChange={(event) => {
                edit();
                setGraceText(event.target.value);
              }}
            />
          </Field>
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Who this affects</h3>
          {figures.isLoading ? (
            <p role="status" className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
              <Spinner />
              Loading the figures…
            </p>
          ) : figures.isError || !figures.data ? (
            <div>
              <p role="alert" className="text-sm text-[var(--danger)]">
                The figures could not be loaded. {apiErrorMessage(figures.error, '')}
              </p>
              <Button
                type="button"
                size="sm"
                className="mt-2"
                disabled={figures.isFetching}
                onClick={() => void figures.refetch()}
              >
                {figures.isFetching && <Spinner />}
                Try again
              </Button>
            </div>
          ) : (
            <ImpactTable impact={figures.data} />
          )}
          {message && (
            <p className="text-sm text-[var(--text-secondary)]" aria-live="polite">
              {message}
            </p>
          )}
        </div>

        {grace === 0 && roles.length > 0 && (
          <Notice tone="warning" title="With 0 days, people are limited at once">
            Everyone in these roles without a second step is limited at their next request: they can
            only set it up or sign out until they do. Choose a grace period if people need time to
            prepare.
          </Notice>
        )}

        {refusal && (
          <Notice tone="warning" title="This requirement cannot be saved yet">
            {refusal}{' '}
            <Link
              to="/settings"
              className="text-[var(--accent-bright)] underline hover:no-underline"
            >
              Set it up under Settings → Account
            </Link>
          </Notice>
        )}

        <SaveRow
          hasChanges={hasChanges}
          isPending={save.isPending}
          errorMessage={
            refusal
              ? null
              : save.error
                ? apiErrorMessage(save.error, 'The requirement could not be saved.')
                : null
          }
          successMessage={savedMessage ? 'Two-step verification requirement saved.' : null}
          subject="the two-step verification requirement"
        />
      </form>
    </SettingsSection>
  );
}
