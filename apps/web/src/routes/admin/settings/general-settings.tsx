import { COLOR_THEMES, type ColorTheme, type InstanceSettings } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { Notice, SaveRow, SettingsSection, ToggleSetting } from '~/components/admin/admin-ui';
import { Field } from '~/components/ui/field';
import { Textarea } from '~/components/ui/input';
import { ApiError, api } from '~/lib/api-client';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';

type Features = InstanceSettings['features'];
type FeaturesPatch = Partial<Features>;

const FEATURE_SECTIONS: Array<{
  title: string;
  description: string;
  settings: Array<{ key: keyof Features; label: string; description: string }>;
}> = [
  {
    title: 'Conversation features',
    description: 'Control optional ways people can create, organize, and distribute chats.',
    settings: [
      {
        key: 'shareLinks',
        label: 'Share links',
        description:
          'Allow public conversation links in clients that support sharing. Review your data-sharing policy before enabling this.',
      },
      {
        key: 'temporaryChat',
        label: 'Temporary chats',
        description: 'Allow conversations intended not to appear in persistent chat history.',
      },
      {
        key: 'personas',
        label: 'Personas',
        description: 'Allow people to use saved assistant personas where supported.',
      },
      {
        key: 'branching',
        label: 'Conversation branching',
        description: 'Allow supported clients to branch a conversation from an earlier message.',
      },
    ],
  },
  {
    title: 'Tools and content',
    description: 'Control optional inputs and tools that can be made available during a chat.',
    settings: [
      {
        key: 'attachments',
        label: 'File attachments',
        description: 'Permit file uploads and attaching supported files to model messages.',
      },
      {
        key: 'webSearch',
        label: 'Web search',
        description: 'Permit configured web search grounding during model requests.',
      },
      {
        key: 'canvas',
        label: 'Canvas',
        description: 'Expose canvas experiences in clients that implement them.',
      },
      {
        key: 'mcp',
        label: 'MCP tools',
        description:
          'Expose Model Context Protocol tools in clients and providers that support them.',
      },
    ],
  },
];

function changedFeatures(saved: Features, draft: Features): FeaturesPatch {
  const patch: FeaturesPatch = {};

  for (const key of Object.keys(saved) as Array<keyof Features>) {
    if (saved[key] !== draft[key]) patch[key] = draft[key];
  }

  return patch;
}

function normalizedPrompt(value: string | null): string | null {
  return value?.trim() ? value : null;
}

const COLOR_THEME_LABELS: Record<ColorTheme, string> = {
  neutral: 'Neutral',
  blue: 'Blue',
  violet: 'Violet',
  emerald: 'Emerald',
};

/**
 * Swatches render from the theme's own tokens via `data-color-theme`, so a
 * preview can never drift from the palette it advertises.
 */
function ColorThemeForm({ initialTheme }: { initialTheme: ColorTheme }) {
  const queryClient = useQueryClient();
  const { setColorTheme } = useTheme();
  const [saved, setSaved] = useState(initialTheme);
  const [draft, setDraft] = useState(initialTheme);
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (colorTheme: ColorTheme) =>
      api.patch<{ ok: boolean }>('/admin/settings', { colorTheme }),
    onSuccess: (_response, colorTheme) => {
      setSaved(colorTheme);
      setErrorMessage(null);
      setSuccessMessage(true);
      // Apply immediately rather than waiting for the next /auth/status refetch.
      setColorTheme(colorTheme);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, colorTheme } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['auth', 'status'] });
    },
    onError: (error) => {
      setSuccessMessage(false);
      setErrorMessage(
        error instanceof ApiError ? error.message : 'Unable to save the color theme.',
      );
    },
  });

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft !== saved) save.mutate(draft);
      }}
    >
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">Instance color theme</legend>
        {COLOR_THEMES.map((theme) => {
          const selected = draft === theme;
          return (
            <label
              key={theme}
              data-color-theme={theme}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-xl border px-4 py-3 transition-colors',
                selected
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-[var(--border-subtle)] hover:bg-[var(--bg-control)]/50',
              )}
            >
              <input
                type="radio"
                name="color-theme"
                value={theme}
                checked={selected}
                disabled={save.isPending}
                className="sr-only"
                onChange={() => {
                  setDraft(theme);
                  setErrorMessage(null);
                  setSuccessMessage(false);
                }}
              />
              <span
                aria-hidden="true"
                className="flex size-6 items-center justify-center rounded-full bg-[var(--accent)]"
              >
                {selected && <Check className="size-3.5 text-[var(--accent-foreground)]" />}
              </span>
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {COLOR_THEME_LABELS[theme]}
              </span>
            </label>
          );
        })}
      </fieldset>

      <SaveRow
        hasChanges={draft !== saved}
        isPending={save.isPending}
        errorMessage={errorMessage}
        successMessage={successMessage ? 'Color theme saved.' : null}
      />
    </form>
  );
}

function DefaultPromptForm({ initialPrompt }: { initialPrompt: string | null }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(() => normalizedPrompt(initialPrompt));
  const [draft, setDraft] = useState(() => normalizedPrompt(initialPrompt) ?? '');
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const normalizedDraft = normalizedPrompt(draft);
  const hasChanges = saved !== normalizedDraft;

  const save = useMutation({
    mutationFn: (defaultSystemPrompt: string | null) =>
      api.patch<{ ok: boolean }>('/admin/settings', { defaultSystemPrompt }),
    onSuccess: (_response, defaultSystemPrompt) => {
      setSaved(defaultSystemPrompt);
      setDraft(defaultSystemPrompt ?? '');
      setErrorMessage(null);
      setSuccessMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, defaultSystemPrompt } : current,
      );
    },
    onError: (error) => {
      setSuccessMessage(false);
      setErrorMessage(
        error instanceof ApiError ? error.message : 'Unable to save the system prompt.',
      );
    },
  });

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (hasChanges) save.mutate(normalizedDraft);
      }}
    >
      <Field
        label="System instructions"
        htmlFor="default-system-prompt"
        hint="Leave blank to use the built-in helpful-assistant default. User customization is appended after these instructions."
      >
        <Textarea
          id="default-system-prompt"
          rows={8}
          value={draft}
          disabled={save.isPending}
          placeholder="You are a helpful assistant…"
          onChange={(event) => {
            setDraft(event.target.value);
            setErrorMessage(null);
            setSuccessMessage(false);
          }}
        />
      </Field>

      <SaveRow
        hasChanges={hasChanges}
        isPending={save.isPending}
        errorMessage={errorMessage}
        successMessage={successMessage ? 'Default system prompt saved.' : null}
      />
    </form>
  );
}

function searchDependencyMessage(search: InstanceSettings['search']): string | null {
  if (!search.enabled) return 'Enable search on the Search page.';
  if (search.provider === null) return 'Choose a provider on the Search page.';
  if (search.provider === 'searxng' && !search.baseUrl) {
    return 'Set a SearXNG base URL on the Search page.';
  }
  if (search.provider !== 'searxng' && !search.hasCredential) {
    return `Add a credential for ${search.provider} on the Search page.`;
  }
  return null;
}

function FeatureSettingsForm({ settings }: { settings: InstanceSettings }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(settings.features);
  const [draft, setDraft] = useState(settings.features);
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const patch = changedFeatures(saved, draft);
  const hasChanges = Object.keys(patch).length > 0;
  const missingSearchDependency = searchDependencyMessage(settings.search);

  const save = useMutation({
    mutationFn: (features: FeaturesPatch) =>
      api.patch<{ ok: boolean }>('/admin/settings', { features }),
    onSuccess: (_response, features) => {
      const next = { ...saved, ...features };
      setSaved(next);
      setDraft(next);
      setErrorMessage(null);
      setSuccessMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, features: next } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (error) => {
      setSuccessMessage(false);
      setErrorMessage(
        error instanceof ApiError ? error.message : 'Unable to save feature settings.',
      );
    },
  });

  function updateFeature(key: keyof Features, value: boolean) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrorMessage(null);
    setSuccessMessage(false);
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (hasChanges) save.mutate(patch);
      }}
    >
      {FEATURE_SECTIONS.map((section) => (
        <div key={section.title}>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{section.title}</h3>
          <p className="mt-1 text-sm text-[var(--text-muted)]">{section.description}</p>
          <div className="mt-2 divide-y divide-[var(--border-subtle)]">
            {section.settings.map((feature) => (
              <ToggleSetting
                key={feature.key}
                id={`feature-${feature.key}`}
                label={feature.label}
                description={feature.description}
                checked={draft[feature.key]}
                disabled={save.isPending}
                onCheckedChange={(checked) => updateFeature(feature.key, checked)}
              />
            ))}
          </div>
        </div>
      ))}

      {draft.webSearch && missingSearchDependency && (
        <Notice tone="warning" title="Web search has an unmet dependency">
          This feature flag alone does not make search available. {missingSearchDependency}{' '}
          <a className="text-[var(--accent-bright)] hover:underline" href="/admin/search">
            Review search settings
          </a>
          .
        </Notice>
      )}

      {draft.attachments && (
        <Notice
          title={`Attachments use ${settings.storage.driver === 's3' ? 'S3' : 'local'} storage`}
        >
          Upload limits, allowed file types, and the active driver are managed on the{' '}
          <a className="text-[var(--accent-bright)] hover:underline" href="/admin/storage">
            Storage page
          </a>
          . Enabling attachments does not validate or migrate that backend.
        </Notice>
      )}

      {draft.shareLinks && (
        <Notice tone="warning" title="Shared content may leave its original audience">
          Enable public links only after confirming your external URL, reverse-proxy controls, and
          data-sharing policy. Anyone who receives a functioning public link may be able to forward
          it.
        </Notice>
      )}

      <SaveRow
        hasChanges={hasChanges}
        isPending={save.isPending}
        errorMessage={errorMessage}
        successMessage={successMessage ? 'Feature settings saved.' : null}
      />
    </form>
  );
}

export function GeneralSettings({ settings }: { settings: InstanceSettings }) {
  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="Appearance"
        description="Choose the accent color applied across the instance. Surfaces stay neutral; only the accent changes."
      >
        <ColorThemeForm initialTheme={settings.colorTheme} />
      </SettingsSection>

      <SettingsSection
        title="Model behavior"
        description="Define the instance default applied to model conversations."
      >
        <DefaultPromptForm initialPrompt={settings.defaultSystemPrompt} />
      </SettingsSection>

      <SettingsSection
        title="Features"
        description="Set instance-wide availability for optional chat capabilities."
      >
        <FeatureSettingsForm settings={settings} />
      </SettingsSection>
    </div>
  );
}
