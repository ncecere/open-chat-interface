import {
  MICROS_PER_DOLLAR,
  type RateLimitSettings,
  type ReserveAmounts,
  type UserRole,
} from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useEffect, useState } from 'react';
import { EditOnly } from '~/components/admin/admin-access';
import { LoadError, MutationError, SettingsSection } from '~/components/admin/admin-ui';
import { ConfigSourceBadge, useConfigSources } from '~/components/admin/config-source';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { Button } from '~/components/ui/button';
import { Field, invalidFieldProps } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { invalidateAccess, isWholeNumberIn } from './roles-helpers';
import { SavedNote, useSavedFlash } from './saved-note';

interface RateLimitConfig {
  roles: Record<UserRole, RateLimitSettings>;
  authAttemptsPerMinute: number;
  reserve: ReserveAmounts;
}

function InstanceWideForm({ settings }: { settings: RateLimitConfig }) {
  const queryClient = useQueryClient();
  const sources = useConfigSources().data?.rateLimits;
  const [auth, setAuth] = useState(String(settings.authAttemptsPerMinute));
  const [costDollars, setCostDollars] = useState(
    (settings.reserve.costMicros / MICROS_PER_DOLLAR).toFixed(2),
  );
  const [tokens, setTokens] = useState(String(settings.reserve.tokens));
  const [saved, setSaved] = useSavedFlash();

  useEffect(() => {
    setAuth(String(settings.authAttemptsPerMinute));
    setCostDollars((settings.reserve.costMicros / MICROS_PER_DOLLAR).toFixed(2));
    setTokens(String(settings.reserve.tokens));
  }, [settings]);

  // Dollars become integer micro-dollars so no amount is stored as a float.
  const costMicros = Math.round(Number(costDollars || 0) * MICROS_PER_DOLLAR);
  // Each field's problem under it, giving its range, as Rate limits does
  // (#302, #321); one sentence below all three named none of them.
  const errors = {
    auth:
      auth.trim() && isWholeNumberIn(Number(auth), 1_000)
        ? null
        : 'Enter a whole number from 1 to 1,000.',
    cost:
      costDollars.trim() && isWholeNumberIn(costMicros, 100_000_000)
        ? null
        : 'Enter an amount from $0.01 to $100.00.',
    tokens:
      tokens.trim() && isWholeNumberIn(Number(tokens), 10_000_000)
        ? null
        : 'Enter a whole number from 1 to 10,000,000.',
  };
  const valid = !errors.auth && !errors.cost && !errors.tokens;

  const patch: {
    authAttemptsPerMinute?: number;
    reserve?: Partial<ReserveAmounts>;
  } = {};
  if (Number(auth) !== settings.authAttemptsPerMinute) patch.authAttemptsPerMinute = Number(auth);
  const reserve: Partial<ReserveAmounts> = {};
  if (costMicros !== settings.reserve.costMicros) reserve.costMicros = costMicros;
  if (Number(tokens) !== settings.reserve.tokens) reserve.tokens = Number(tokens);
  if (Object.keys(reserve).length > 0) patch.reserve = reserve;
  const hasChanges = Object.keys(patch).length > 0;
  useReportUnsaved(hasChanges);

  const save = useMutation({
    mutationFn: () => api.put('/admin/lifecycle/rate-limits', patch),
    onSuccess: async () => {
      setSaved(true);
      await invalidateAccess(queryClient);
    },
  });

  function edit(setter: (value: string) => void) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      save.reset();
      setSaved(false);
      setter(event.target.value);
    };
  }

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (hasChanges && valid) save.mutate();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Sign-in attempts per minute"
          htmlFor="rate-auth"
          error={errors.auth}
          hint="Failed sign-ins per account. An address has its own, larger allowance."
        >
          <Input
            id="rate-auth"
            type="number"
            min="1"
            step="1"
            value={auth}
            {...invalidFieldProps(
              'rate-auth',
              errors.auth,
              sources ? 'rate-auth-source' : undefined,
            )}
            onChange={edit(setAuth)}
          />
          <ConfigSourceBadge id="rate-auth-source" source={sources?.authAttemptsPerMinute} />
        </Field>
        <Field
          label="Budget held per response"
          htmlFor="reserve-cost"
          error={errors.cost}
          hint="In US dollars, released when the response finishes."
        >
          <Input
            id="reserve-cost"
            type="number"
            min="0.01"
            step="0.01"
            value={costDollars}
            {...invalidFieldProps(
              'reserve-cost',
              errors.cost,
              sources ? 'reserve-cost-source' : undefined,
            )}
            onChange={edit(setCostDollars)}
          />
          <ConfigSourceBadge id="reserve-cost-source" source={sources?.reserve.costMicros} />
        </Field>
        <Field
          label="Tokens held per response"
          htmlFor="reserve-tokens"
          error={errors.tokens}
          hint="Used by token budgets in the same way."
        >
          <Input
            id="reserve-tokens"
            type="number"
            min="1"
            step="100"
            value={tokens}
            {...invalidFieldProps(
              'reserve-tokens',
              errors.tokens,
              sources ? 'reserve-tokens-source' : undefined,
            )}
            onChange={edit(setTokens)}
          />
          <ConfigSourceBadge id="reserve-tokens-source" source={sources?.reserve.tokens} />
        </Field>
      </div>

      <p className="text-[var(--text-muted)] text-xs">
        A reservation is held while a response generates, then replaced by what was actually used,
        so simultaneous responses cannot collectively pass a budget. It is never charged.
      </p>

      <EditOnly>
        <div className="flex items-center justify-end gap-3">
          <MutationError
            error={save.error}
            message="Instance-wide limits could not be saved."
            className="mr-auto"
          />
          <SavedNote show={saved} />
          <Button
            type="submit"
            variant="primary"
            disabled={!hasChanges || !valid || save.isPending}
          >
            {save.isPending && <Spinner />}
            Save instance-wide limits
          </Button>
        </div>
      </EditOnly>
    </form>
  );
}

export function InstanceWideSection() {
  const rateLimits = useQuery({
    queryKey: ['admin', 'rate-limits'],
    queryFn: () => api.get<RateLimitConfig>('/admin/lifecycle/rate-limits'),
  });

  return (
    <SettingsSection
      title="Instance-wide"
      description="Limits that apply to everyone regardless of role: sign-in attempts, and the amount reserved while a response generates."
    >
      {rateLimits.data ? (
        <InstanceWideForm settings={rateLimits.data} />
      ) : rateLimits.isError ? (
        <LoadError title="Instance-wide limits could not be loaded." query={rateLimits} />
      ) : (
        <div role="status" aria-label="Loading instance-wide limits">
          <Spinner className="mx-auto size-5" />
        </div>
      )}
    </SettingsSection>
  );
}
