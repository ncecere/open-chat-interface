import {
  DEFAULT_MAX_TOOL_STEPS,
  type InstanceSettings,
  MAX_TOOL_STEPS,
  MIN_TOOL_STEPS,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Notice, SaveRow, SettingsSection, ToggleSetting } from '~/components/admin/admin-ui';
import { EFFORT_LABELS } from '~/components/admin/role-features-form';
import { Field } from '~/components/ui/field';
import { Input, Textarea } from '~/components/ui/input';
import { SETUP_STATUS_QUERY_KEY } from '~/hooks/use-setup-status';
import { ApiError, api } from '~/lib/api-client';

type Features = InstanceSettings['features'];
type FeatureKey = keyof Features;

/**
 * Web search is switched on the Web search page, together with its provider.
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
      {
        key: 'memory',
        label: 'User memory',
        description:
          'Let people opt in to short notes about themselves that are included in their conversations. Models with tools can save and remove notes; people see, edit and delete every note in Settings → Memory. Off by default.',
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

function DefaultEffortForm({ initialEffort }: { initialEffort: ReasoningEffort }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState<ReasoningEffort>(initialEffort ?? 'instant');
  const [draft, setDraft] = useState<ReasoningEffort>(initialEffort ?? 'instant');
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (defaultEffort: ReasoningEffort) =>
      api.patch<{ ok: boolean }>('/admin/settings', { defaultEffort }),
    onSuccess: (_response, defaultEffort) => {
      setSaved(defaultEffort);
      setErrorMessage(null);
      setSuccessMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, defaultEffort } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (error) => {
      setSuccessMessage(false);
      setErrorMessage(
        error instanceof ApiError ? error.message : 'Unable to save the default reasoning level.',
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
      <Field
        label="Default reasoning level"
        htmlFor="default-effort"
        hint="Where new conversations start. When the selected model or a person's role does not allow it, the composer uses Instant instead. Allowed levels per role are set on Roles & access."
      >
        <select
          id="default-effort"
          className="h-9 w-full max-w-xs rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)] px-3 text-sm text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          value={draft}
          disabled={save.isPending}
          onChange={(event) => {
            setDraft(event.target.value as ReasoningEffort);
            setErrorMessage(null);
            setSuccessMessage(false);
          }}
        >
          {REASONING_EFFORTS.map((effort) => (
            <option key={effort} value={effort}>
              {EFFORT_LABELS[effort]}
            </option>
          ))}
        </select>
      </Field>

      <SaveRow
        hasChanges={draft !== saved}
        isPending={save.isPending}
        errorMessage={errorMessage}
        successMessage={successMessage ? 'Default reasoning level saved.' : null}
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

/** How many model steps one reply may take when it uses tools. */
function ToolStepLimitForm({ initialSteps }: { initialSteps: number }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(initialSteps ?? DEFAULT_MAX_TOOL_STEPS);
  const [draft, setDraft] = useState(String(initialSteps ?? DEFAULT_MAX_TOOL_STEPS));
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const value = Number(draft);
  const valid = /^\d+$/.test(draft) && value >= MIN_TOOL_STEPS && value <= MAX_TOOL_STEPS;

  const save = useMutation({
    mutationFn: (maxToolSteps: number) =>
      api.patch<{ ok: boolean }>('/admin/settings', { maxToolSteps }),
    onSuccess: (_response, maxToolSteps) => {
      setSaved(maxToolSteps);
      setErrorMessage(null);
      setSuccessMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, maxToolSteps } : current,
      );
    },
    onError: (error) => {
      setSuccessMessage(false);
      setErrorMessage(
        error instanceof ApiError ? error.message : 'Unable to save the tool step limit.',
      );
    },
  });

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) {
          setErrorMessage(`Enter a whole number from ${MIN_TOOL_STEPS} to ${MAX_TOOL_STEPS}.`);
          return;
        }
        if (value !== saved) save.mutate(value);
      }}
    >
      <Field
        label="Tool step limit"
        htmlFor="max-tool-steps"
        hint={`Steps one reply may spend using tools, from ${MIN_TOOL_STEPS} to ${MAX_TOOL_STEPS}. A reply that reaches it answers with what it found, with a note. Default ${DEFAULT_MAX_TOOL_STEPS}.`}
      >
        <Input
          id="max-tool-steps"
          type="number"
          inputMode="numeric"
          min={MIN_TOOL_STEPS}
          max={MAX_TOOL_STEPS}
          step={1}
          className="max-w-32"
          value={draft}
          aria-invalid={!valid}
          disabled={save.isPending}
          onChange={(event) => {
            setDraft(event.target.value);
            setErrorMessage(null);
            setSuccessMessage(false);
          }}
        />
      </Field>

      <SaveRow
        hasChanges={draft !== String(saved)}
        isPending={save.isPending}
        errorMessage={errorMessage}
        successMessage={successMessage ? 'Tool step limit saved.' : null}
      />
    </form>
  );
}

/** Whether long conversations are summarised instead of losing their oldest turns. */
function AutoCompactForm({ initialEnabled }: { initialEnabled: boolean }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(initialEnabled ?? true);
  const [draft, setDraft] = useState(initialEnabled ?? true);
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (autoCompact: boolean) =>
      api.patch<{ ok: boolean }>('/admin/settings', { autoCompact }),
    onSuccess: (_response, autoCompact) => {
      setSaved(autoCompact);
      setErrorMessage(null);
      setSuccessMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, autoCompact } : current,
      );
    },
    onError: (error) => {
      setSuccessMessage(false);
      setErrorMessage(
        error instanceof ApiError ? error.message : 'Unable to save the compaction setting.',
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
      <ToggleSetting
        id="auto-compact"
        label="Summarise long conversations"
        description="When a conversation outgrows the model's input, its earlier messages are summarised by the conversation's model (counting towards the person's usage) instead of being left out. People can still compact a conversation themselves when this is off."
        checked={draft}
        disabled={save.isPending}
        onCheckedChange={(checked) => {
          setDraft(checked);
          setErrorMessage(null);
          setSuccessMessage(false);
        }}
      />
      <SaveRow
        hasChanges={draft !== saved}
        isPending={save.isPending}
        errorMessage={errorMessage}
        successMessage={successMessage ? 'Compaction setting saved.' : null}
      />
    </form>
  );
}

/**
 * Whether models are asked to draw diagrams following the Diagram Design style
 * guide (MIT, Cathryn Lavery) when artifacts are available.
 */
function DiagramGuidanceForm({ initialEnabled }: { initialEnabled: boolean }) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(initialEnabled ?? true);
  const [draft, setDraft] = useState(initialEnabled ?? true);
  const [successMessage, setSuccessMessage] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (diagramGuidance: boolean) =>
      api.patch<{ ok: boolean }>('/admin/settings', { diagramGuidance }),
    onSuccess: (_response, diagramGuidance) => {
      setSaved(diagramGuidance);
      setErrorMessage(null);
      setSuccessMessage(true);
      queryClient.setQueryData<InstanceSettings>(['admin', 'settings'], (current) =>
        current ? { ...current, diagramGuidance } : current,
      );
    },
    onError: (error) => {
      setSuccessMessage(false);
      setErrorMessage(
        error instanceof ApiError ? error.message : 'Unable to save the diagram setting.',
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
      <ToggleSetting
        id="diagram-guidance"
        label="Editorial diagrams"
        description="When artifacts are available, ask models to draw diagrams as SVG artifacts following the Diagram Design style guide (MIT, Cathryn Lavery), using this instance's accent color. Artifacts themselves are switched per role on Roles & access."
        checked={draft}
        disabled={save.isPending}
        onCheckedChange={(checked) => {
          setDraft(checked);
          setErrorMessage(null);
          setSuccessMessage(false);
        }}
      />
      <SaveRow
        hasChanges={draft !== saved}
        isPending={save.isPending}
        errorMessage={errorMessage}
        successMessage={successMessage ? 'Diagram setting saved.' : null}
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
        <div className="flex flex-col gap-8">
          <DefaultPromptForm initialPrompt={settings.defaultSystemPrompt} />
          <DefaultEffortForm initialEffort={settings.defaultEffort} />
          <ToolStepLimitForm initialSteps={settings.maxToolSteps} />
          <AutoCompactForm initialEnabled={settings.autoCompact} />
          <DiagramGuidanceForm initialEnabled={settings.diagramGuidance} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Features"
        description="Set instance-wide availability for optional chat capabilities. Each role can be narrowed further on Roles & access. Web search is switched on with its provider on the Web search page; the accent color is on Branding."
      >
        <FeatureSettingsForm settings={settings} />
      </SettingsSection>
    </div>
  );
}
