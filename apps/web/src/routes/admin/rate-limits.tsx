import {
  MICROS_PER_DOLLAR,
  type RateLimitSettings,
  type ReserveAmounts,
  USER_ROLES,
  type UserRole,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { type AdminTab, AdminTabs } from '~/components/admin/admin-tabs';
import {
  AdminPageHeader,
  LoadError,
  MutationError,
  Notice,
  SettingsSection,
} from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import {
  DEFAULT_RATE_LIMIT_TAB,
  type RateLimitTab,
  validateRateLimitSearch,
} from '~/lib/admin-search';
import { api } from '~/lib/api-client';

const TABS = [
  { id: 'roles', label: 'By role' },
  { id: 'reservations', label: 'Reservations' },
] as const satisfies readonly AdminTab<RateLimitTab>[];

interface RateLimitConfig {
  roles: Record<UserRole, RateLimitSettings>;
  authAttemptsPerMinute: number;
  reserve: ReserveAmounts;
}

function RateLimitForm({ settings }: { settings: RateLimitConfig }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(settings), [settings]);

  const save = useMutation({
    mutationFn: () => api.put('/admin/lifecycle/rate-limits', draft),
    onSuccess: async () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2_500);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'rate-limits'] });
    },
  });

  function update(role: UserRole, key: keyof RateLimitSettings, value: number) {
    setDraft((current) => ({
      ...current,
      roles: { ...current.roles, [role]: { ...current.roles[role], [key]: value } },
    }));
  }

  const navigate = useNavigate();
  const tab = validateRateLimitSearch(useSearch({ strict: false })).tab ?? DEFAULT_RATE_LIMIT_TAB;
  const setTab = (next: RateLimitTab) =>
    void navigate({
      to: '/admin/rate-limits',
      search: { tab: next === DEFAULT_RATE_LIMIT_TAB ? undefined : next },
      replace: true,
    });

  return (
    <div className="flex flex-col gap-8 pb-10">
      <AdminTabs tabs={TABS} active={tab} onChange={setTab} label="Rate limit sections" />

      <div
        hidden={tab !== 'roles'}
        id="panel-roles"
        role="tabpanel"
        className="flex flex-col gap-10"
      >
        <SettingsSection
          title="By role"
          description="Concurrency bounds how many generations one person may run at once. The per-minute limits bound how fast requests arrive."
        >
          <div className="flex flex-col gap-5">
            {USER_ROLES.map((role) => (
              <div key={role} className="border-[var(--border-subtle)] border-b pb-5 last:border-0">
                <h3 className="font-medium text-sm capitalize">{role}</h3>
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <Field
                    label="Concurrent responses"
                    htmlFor={`rate-${role}-concurrent`}
                    hint="How many generations may run at once."
                  >
                    <Input
                      id={`rate-${role}-concurrent`}
                      type="number"
                      min="1"
                      value={draft.roles[role].maxConcurrentStreams}
                      onChange={(event) =>
                        update(role, 'maxConcurrentStreams', Number(event.target.value))
                      }
                    />
                  </Field>

                  <Field label="Messages per minute" htmlFor={`rate-${role}-chat`}>
                    <Input
                      id={`rate-${role}-chat`}
                      type="number"
                      min="1"
                      value={draft.roles[role].chatRequestsPerMinute}
                      onChange={(event) =>
                        update(role, 'chatRequestsPerMinute', Number(event.target.value))
                      }
                    />
                  </Field>

                  <Field label="Uploads per minute" htmlFor={`rate-${role}-upload`}>
                    <Input
                      id={`rate-${role}-upload`}
                      type="number"
                      min="1"
                      value={draft.roles[role].uploadRequestsPerMinute}
                      onChange={(event) =>
                        update(role, 'uploadRequestsPerMinute', Number(event.target.value))
                      }
                    />
                  </Field>
                </div>
              </div>
            ))}
          </div>
        </SettingsSection>

        <SettingsSection
          title="Sign-in attempts"
          description="Counted per IP address and per account, so neither can be varied to evade the limit."
        >
          <Field label="Attempts per minute" htmlFor="rate-auth">
            <Input
              id="rate-auth"
              type="number"
              min="1"
              className="sm:max-w-48"
              value={draft.authAttemptsPerMinute}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  authAttemptsPerMinute: Number(event.target.value),
                }))
              }
            />
          </Field>
        </SettingsSection>
      </div>

      <div
        hidden={tab !== 'reservations'}
        id="panel-reservations"
        role="tabpanel"
        className="flex flex-col gap-10"
      >
        <SettingsSection
          title="Reservations"
          description="Held while a response generates, then replaced by what was actually used. Without a reservation, simultaneous runs all measure the same starting point and can collectively pass a limit; the concurrency cap above bounds the rest."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Budget held per response"
              htmlFor="reserve-cost"
              hint="In US dollars. Anything unused is released as soon as the response finishes."
            >
              <Input
                id="reserve-cost"
                type="number"
                min="0.01"
                step="0.01"
                value={(draft.reserve.costMicros / MICROS_PER_DOLLAR).toFixed(2)}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    reserve: {
                      ...current.reserve,
                      // Dollars are converted to integer micro-dollars so no
                      // amount is ever stored as a float.
                      costMicros: Math.max(
                        1,
                        Math.round(Number(event.target.value || 0) * MICROS_PER_DOLLAR),
                      ),
                    },
                  }))
                }
              />
            </Field>

            <Field
              label="Tokens held per response"
              htmlFor="reserve-tokens"
              hint="Used by token limits in the same way."
            >
              <Input
                id="reserve-tokens"
                type="number"
                min="1"
                step="100"
                value={draft.reserve.tokens}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    reserve: {
                      ...current.reserve,
                      tokens: Math.max(1, Number(event.target.value || 1)),
                    },
                  }))
                }
              />
            </Field>
          </div>

          <p className="mt-3 text-[var(--text-muted)] text-xs">
            A larger reservation keeps limits tighter but makes someone near their limit look closer
            to it while a response is generating. It is never charged, and someone with less than
            this left still gets one more response rather than being locked out of the remainder.
          </p>
        </SettingsSection>
      </div>

      <Notice title="Limits are shared across replicas through Redis">
        Without Redis these fall back to per-process counting, which means the effective limit is
        multiplied by the number of API replicas.
      </Notice>

      <EditOnly>
        <div className="flex items-center justify-end gap-3">
          <MutationError
            error={save.error}
            message="Rate limits could not be saved."
            className="mr-auto"
          />
          {saved && (
            <span className="mr-auto flex items-center gap-1.5 text-[var(--success)] text-sm">
              <CheckCircle2 className="size-4" aria-hidden="true" />
              Saved
            </span>
          )}
          <Button
            type="button"
            variant="primary"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Spinner />}
            Save limits
          </Button>
        </div>
      </EditOnly>
    </div>
  );
}

export function AdminRateLimitsPage() {
  const rateLimits = useQuery({
    queryKey: ['admin', 'rate-limits'],
    queryFn: () => api.get<RateLimitConfig>('/admin/lifecycle/rate-limits'),
  });

  return (
    <div>
      <AdminPageHeader
        title="Rate limits"
        description="A quota bounds how much someone may use over a window. These bound how fast requests arrive and how many generations run at once, which is what stops one account exhausting the instance."
      />

      {rateLimits.data ? (
        <RateLimitForm settings={rateLimits.data} />
      ) : rateLimits.isError ? (
        <LoadError title="Rate limits could not be loaded." query={rateLimits} />
      ) : (
        <div role="status" aria-label="Loading rate limits">
          <Spinner className="mx-auto size-5" />
        </div>
      )}
    </div>
  );
}
