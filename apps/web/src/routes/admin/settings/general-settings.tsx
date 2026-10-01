import type { InstanceSettings } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Notice, SaveRow, SettingsSection, ToggleSetting } from '~/components/admin/admin-ui';
import { Field } from '~/components/ui/field';
import { Textarea } from '~/components/ui/input';
import { SETUP_STATUS_QUERY_KEY } from '~/hooks/use-setup-status';
import { ApiError, api } from '~/lib/api-client';

type Features = InstanceSettings['features'];
type FeatureKey = keyof Features;

/**
 * Only features the server enforces are listed. Canvas and MCP remain in the
 * stored settings but nothing reads them yet, so they are not offered. Web
 * search is switched on the Web search page, together with its provider.
 *
 * The server replaces the stored features object on every write, so the whole
 * object is sent: unlisted values go back exactly as they were loaded.
 */
const FEATURE_SECTIONS: Array<{
  title: string;
  description: string;
  settings: Array<{ key: FeatureKey; label: string; description: string }>;
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
    ],
  },
];

function featuresChanged(saved: Features, draft: Features): boolean {
  return (Object.keys(saved) as FeatureKey[]).some((key) => saved[key] !== draft[key]);
}

function normalizedPrompt(value: string | null): string | null {
  return value?.trim() ? value : null;
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

function FeatureSettingsForm({ settings }: { settings: InstanceSettings }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(settings.features);
  const [draft, setDraft] = useState(settings.features);
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const hasChanges = featuresChanged(saved, draft);

  const save = useMutation({
    mutationFn: (features: Features) => api.patch<{ ok: boolean }>('/admin/settings', { features }),
    onSuccess: (_response, next) => {
      setSaved(next);
      setDraft(next);
      setErrorMessage(null);
      setSuccessMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, features: next } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      void queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY });
    },
    onError: (error) => {
      setSuccessMessage(false);
      setErrorMessage(
        error instanceof ApiError ? error.message : 'Unable to save feature settings.',
      );
    },
  });

  function updateFeature(key: FeatureKey, value: boolean) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrorMessage(null);
    setSuccessMessage(false);
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (hasChanges) save.mutate(draft);
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

export function GeneralSettings({ settings }: { settings: InstanceSettings }) {
  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        title="Model behavior"
        description="Instructions applied to every conversation. The default model is chosen on Providers & Models."
      >
        <DefaultPromptForm initialPrompt={settings.defaultSystemPrompt} />
      </SettingsSection>

      <SettingsSection
        title="Features"
        description="Set instance-wide availability for optional chat capabilities. Web search is switched on with its provider on the Web search page; the accent color is on Branding."
      >
        <FeatureSettingsForm settings={settings} />
      </SettingsSection>
    </div>
  );
}
