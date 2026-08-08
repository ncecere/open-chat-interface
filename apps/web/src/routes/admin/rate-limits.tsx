import { type RateLimitSettings, USER_ROLES, type UserRole } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AdminPageHeader, Notice, SettingsSection } from '~/components/admin/admin-ui';
import { Button } from '~/components/ui/button';
import { Field } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';

interface RateLimitConfig {
  roles: Record<UserRole, RateLimitSettings>;
  authAttemptsPerMinute: number;
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

  return (
    <div className="flex flex-col gap-10 pb-10">
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

      <Notice title="Limits are shared across replicas through Redis">
        Without Redis these fall back to per-process counting, which means the effective limit is
        multiplied by the number of API replicas.
      </Notice>

      <div className="flex items-center justify-end gap-3">
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
    </div>
  );
}

export function AdminRateLimitsPage() {
  const rateLimits = useQuery({
    queryKey: ['admin', 'rate-limits'],
    queryFn: () => api.get<RateLimitConfig>('/admin/lifecycle/rate-limits'),
  });

  return (
    <div className="mx-auto w-full max-w-4xl">
      <AdminPageHeader
        title="Rate limits"
        description="A quota bounds how much someone may use over a window. These bound how fast requests arrive and how many generations run at once, which is what stops one account exhausting the instance."
      />

      {rateLimits.data ? (
        <RateLimitForm settings={rateLimits.data} />
      ) : (
        <Spinner className="mx-auto size-5" />
      )}
    </div>
  );
}
