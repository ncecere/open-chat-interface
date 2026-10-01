import type { ConfigSource, RetentionSettings, UserRole } from '@oci/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

/** GET /admin/lifecycle/config-sources. */
export interface ConfigSources {
  retention: Record<keyof RetentionSettings, ConfigSource>;
  rateLimits: {
    roles: Record<
      UserRole,
      Record<
        'maxConcurrentStreams' | 'chatRequestsPerMinute' | 'uploadRequestsPerMinute',
        ConfigSource
      >
    >;
    authAttemptsPerMinute: ConfigSource;
    reserve: { costMicros: ConfigSource; tokens: ConfigSource };
  };
}

export const CONFIG_SOURCES_QUERY_KEY = ['admin', 'config-sources'] as const;

/**
 * Kept apart from the settings bodies, which are sent back on save and
 * validated strictly, so a source label can never leak into a write.
 */
export function useConfigSources() {
  return useQuery({
    queryKey: CONFIG_SOURCES_QUERY_KEY,
    queryFn: () => api.get<ConfigSources>('/admin/lifecycle/config-sources'),
  });
}

export const CONFIG_SOURCE_LABELS: Record<ConfigSource, string> = {
  database: 'Saved',
  environment: 'From environment',
  default: 'Built-in default',
};

const CONFIG_SOURCE_HINTS: Record<ConfigSource, string> = {
  database: 'Saved on this page; overrides the environment and the built-in default.',
  environment: 'Set by an environment variable. Saving here overrides it.',
  default: 'Nothing is configured, so the built-in default applies. Saving here overrides it.',
};

/**
 * Where a setting's current value comes from. Shown beside a field so an
 * administrator can tell a deliberate value from an inherited one before
 * changing it.
 */
export function ConfigSourceBadge({
  source,
  id,
  className,
}: {
  source: ConfigSource | undefined;
  id?: string;
  className?: string;
}) {
  if (!source) return null;
  return (
    <span
      id={id}
      title={CONFIG_SOURCE_HINTS[source]}
      data-source={source}
      className={cn(
        'inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium',
        source === 'database'
          ? 'border-[var(--accent)]/40 text-[var(--text-secondary)]'
          : 'border-[var(--border-subtle)] text-[var(--text-muted)]',
        className,
      )}
    >
      <span className="sr-only">Source: </span>
      {CONFIG_SOURCE_LABELS[source]}
    </span>
  );
}
