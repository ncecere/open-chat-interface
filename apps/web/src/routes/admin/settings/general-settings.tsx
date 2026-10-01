import { type AdminModel, COLOR_THEMES, type ColorTheme, type InstanceSettings } from '@oci/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { useState } from 'react';
import {
  LoadError,
  Notice,
  SaveRow,
  SettingsSection,
  ToggleSetting,
} from '~/components/admin/admin-ui';
import { Field } from '~/components/ui/field';
import { Textarea } from '~/components/ui/input';
import { Select } from '~/components/ui/select';
import { Spinner } from '~/components/ui/spinner';
import { ApiError, api } from '~/lib/api-client';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';

type Features = InstanceSettings['features'];
type FeaturesPatch = Partial<Features>;

/**
 * Only features the server enforces are listed. Canvas and MCP remain in the
 * stored settings but nothing reads them yet, so they are not offered; because
 * only rendered toggles can change, changedFeatures never sends them.
 */
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
  const { setColorTheme, resolvedTheme } = useTheme();
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
                // Accent tokens differ between light and dark, so a swatch has
                // to carry the active mode to preview the right variant.
                resolvedTheme,
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
  if (!search.enabled) return 'Enable search on the Web search page.';
  if (search.provider === null) return 'Choose a provider on the Web search page.';
  if (search.provider === 'searxng' && !search.baseUrl) {
    return 'Set a SearXNG base URL on the Web search page.';
  }
  if (search.provider !== 'searxng' && !search.hasCredential) {
    return `Add a credential for ${search.provider} on the Web search page.`;
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
          <Link className="text-[var(--accent-bright)] hover:underline" to="/admin/search">
            Review search settings
          </Link>
          .
        </Notice>
      )}

      {draft.attachments && (
        <Notice
          title={`Attachments use ${settings.storage.driver === 's3' ? 'S3' : 'local'} storage`}
        >
          Upload limits, allowed file types, and the active driver are managed on the{' '}
          <Link className="text-[var(--accent-bright)] hover:underline" to="/admin/storage">
            Storage page
          </Link>
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

/**
 * Chooses the model a new conversation starts on.
 *
 * The flag still lives on the model row, which keeps one source of truth, but
 * the decision belongs with the other instance-wide defaults rather than
 * buried in a per-model form where it reads as a property of that one model.
 */
function DefaultModelForm() {
  const queryClient = useQueryClient();
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const modelsQuery = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: () => api.get<{ models: AdminModel[] }>('/admin/models'),
  });
  const { data, isLoading } = modelsQuery;

  const models = data?.models ?? [];
  const enabled = models.filter((model) => model.enabled);
  const current = models.find((model) => model.isDefault);

  const save = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/models/${id}`, { isDefault: true }),
    onSuccess: async () => {
      setErrorMessage(null);
      setSuccessMessage(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'models'] }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
      ]);
    },
    onError: (error) => {
      setSuccessMessage(false);
      setErrorMessage(
        error instanceof ApiError ? error.message : 'Unable to save the default model.',
      );
    },
  });

  if (isLoading) return <Spinner className="size-5" />;

  if (!data) return <LoadError title="Models could not be loaded." query={modelsQuery} />;

  if (enabled.length === 0) {
    return (
      <p className="text-[var(--text-muted)] text-sm">
        No models are enabled yet. Enable one in the model catalog first.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Default model"
        htmlFor="default-model"
        hint="Used when someone starts a conversation without choosing a model."
      >
        <Select
          id="default-model"
          value={current?.id ?? ''}
          disabled={save.isPending}
          placeholder="Select a model"
          onChange={(id) => {
            setSuccessMessage(false);
            save.mutate(id);
          }}
          options={enabled.map((model) => ({ value: model.id, label: model.displayName }))}
          className="sm:max-w-96"
        />
      </Field>

      <div aria-live="polite" className="min-h-5">
        {errorMessage && (
          <p role="alert" className="text-[var(--danger)] text-sm">
            {errorMessage}
          </p>
        )}
        {successMessage && (
          <p className="flex items-center gap-1.5 text-[var(--success)] text-sm">
            <Check className="size-4" aria-hidden="true" />
            Default model saved.
          </p>
        )}
      </div>
    </div>
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
        <div className="flex flex-col gap-8">
          <DefaultModelForm />
          <DefaultPromptForm initialPrompt={settings.defaultSystemPrompt} />
        </div>
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
