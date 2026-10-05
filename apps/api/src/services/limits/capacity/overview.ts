import { asc, schema } from '@oci/db';
import type { ProviderCapacityOverview } from '@oci/shared';
import { db } from '../../../db/index.js';
import { logger } from '../../../lib/logger.js';
import { providerCapacityStatus } from './index.js';
import { capacitySettings, normalizeLimits } from './settings.js';

/** Limits, queue settings and the live state of every provider's queue. */
export async function capacityOverview(): Promise<ProviderCapacityOverview> {
  const [settings, providers, models] = await Promise.all([
    capacitySettings(),
    db
      .select({ id: schema.provider.id, label: schema.provider.label })
      .from(schema.provider)
      .orderBy(asc(schema.provider.label)),
    db
      .select({
        id: schema.model.id,
        providerId: schema.model.providerId,
        slug: schema.model.slug,
        displayName: schema.model.displayName,
      })
      .from(schema.model)
      .orderBy(asc(schema.model.sortOrder), asc(schema.model.displayName)),
  ]);
  let enforcement: ProviderCapacityOverview['enforcement'] = 'local';
  const rows = await Promise.all(
    providers.map(async (provider) => {
      const live = await providerCapacityStatus(provider.id).catch((error: unknown) => {
        logger.warn({ error, providerId: provider.id }, 'Could not read provider capacity');
        return null;
      });
      if (live?.kind === 'shared') enforcement = 'shared';
      const status = live?.status;
      return {
        providerId: provider.id,
        label: provider.label,
        limits: normalizeLimits(settings.providers[provider.id]),
        queued: status?.queued ?? 0,
        activeStreams: status?.activeStreams ?? 0,
        throttledLastHour: status?.throttledLastHour ?? 0,
        waitsLastHour: status?.waitsLastHour ?? 0,
        longestWaitSeconds:
          status?.longestWaitMs != null ? Math.round(status.longestWaitMs / 1000) : null,
        coolingUntil: status?.coolingUntil ? new Date(status.coolingUntil).toISOString() : null,
        models: models
          .filter((model) => model.providerId === provider.id)
          .map((model) => ({
            modelId: model.id,
            slug: model.slug,
            displayName: model.displayName,
            limits: normalizeLimits(settings.models[model.id]),
          })),
      };
    }),
  );
  return { queue: settings.queue, enforcement, providers: rows };
}

/**
 * System health: providers that queue turns or throttle OCI. A warning, not
 * an error: turns wait instead of failing, but it means the limits (OCI's or
 * the provider's) are reached.
 */
export async function capacityHealthCheck() {
  const base = { id: 'capacity', label: 'Provider capacity' } as const;
  const overview = await capacityOverview();
  const limited = overview.providers.filter(
    (provider) =>
      Object.values(provider.limits).some((value) => value !== null) ||
      provider.models.some((model) => Object.values(model.limits).some((value) => value !== null)),
  );
  const busy = overview.providers.filter(
    (provider) =>
      provider.queued > 0 || provider.throttledLastHour > 0 || provider.waitsLastHour > 0,
  );
  const scope =
    overview.enforcement === 'shared'
      ? 'shared by every replica'
      : 'per replica (Redis is unavailable)';
  if (busy.length === 0)
    return {
      ...base,
      status: 'ok' as const,
      detail:
        limited.length === 0
          ? 'No limits set; turns never wait. No provider asked OCI to slow down in the last hour.'
          : `Limits set for ${limited.length} provider${limited.length === 1 ? '' : 's'}, ${scope}. Nothing waited or was throttled in the last hour.`,
    };
  const parts = busy.map((provider) => {
    const facts = [
      provider.queued > 0 ? `${provider.queued} waiting now` : null,
      provider.waitsLastHour > 0
        ? `${provider.waitsLastHour} waited in the last hour (longest ${provider.longestWaitSeconds ?? 0} s)`
        : null,
      provider.throttledLastHour > 0
        ? `${provider.throttledLastHour} rate-limit or overload answer${provider.throttledLastHour === 1 ? '' : 's'} in the last hour`
        : null,
    ].filter(Boolean);
    return `${provider.label}: ${facts.join(', ')}`;
  });
  return { ...base, status: 'warn' as const, detail: `${parts.join('. ')}. Limits ${scope}.` };
}
