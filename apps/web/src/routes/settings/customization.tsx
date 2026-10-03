import type { ThemeMode } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Monitor, Moon, Plus, Sun } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useState } from 'react';
import { Button } from '~/components/ui/button';
import { Switch } from '~/components/ui/switch';
import { useCurrentUser } from '~/hooks/use-current-user';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';

const SUGGESTED_TRAITS = [
  'friendly',
  'witty',
  'concise',
  'curious',
  'empathetic',
  'creative',
  'patient',
];

const LIMITS = { name: 50, occupation: 100, trait: 100, context: 3000 };

function CountedInput({
  id,
  value,
  onChange,
  placeholder,
  max,
  multiline,
  onKeyDown,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  max: number;
  multiline?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const shared = cn(
    'w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-control)]/60 px-3 text-sm',
    'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
    'transition-colors focus:border-[var(--border-strong)]',
  );

  return (
    <div className="relative">
      {multiline ? (
        <textarea
          id={id}
          rows={5}
          maxLength={max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={cn(shared, 'resize-none py-2.5 pb-8')}
        />
      ) : (
        <input
          id={id}
          maxLength={max}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className={cn(shared, 'h-11 pr-16')}
        />
      )}
      <span className="pointer-events-none absolute bottom-2.5 right-3 text-xs text-[var(--text-muted)]">
        {value.length}/{max}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="text-xl font-bold">{title}</h2>
      <div className="mt-4 flex flex-col gap-6">{children}</div>
    </section>
  );
}

const APPEARANCES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

/**
 * Light, Dark or System, the same choice as the chat's appearance menu and
 * kept per browser. Native radio buttons, so arrow keys and screen readers
 * work as they do everywhere else.
 */
function AppearanceRow() {
  const { theme, setTheme } = useTheme();
  const id = useId();
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div>
        <p id={`${id}-label`} className="text-sm font-medium text-[var(--text-primary)]">
          Appearance
        </p>
        <p
          id={`${id}-description`}
          className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]"
        >
          Light, dark, or follow your device's setting. Saved in this browser.
        </p>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        className="inline-flex shrink-0 gap-1 self-start rounded-xl bg-[var(--bg-segment-track)] p-1"
      >
        {APPEARANCES.map((option) => (
          <label
            key={option.value}
            className={cn(
              'flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors',
              'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--accent-bright)]',
              theme === option.value
                ? 'bg-[var(--bg-segment-active)] font-medium text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            <input
              type="radio"
              name={`${id}-appearance`}
              value={option.value}
              checked={theme === option.value}
              onChange={() => setTheme(option.value as ThemeMode)}
              className="sr-only"
            />
            <option.icon className="size-3.5" aria-hidden="true" />
            {option.label}
          </label>
        ))}
      </div>
    </div>
  );
}

interface Personalisation {
  displayName: string | null;
  occupation: string | null;
  traits: string[];
  additionalContext: string | null;
}

function samePersonalisation(left: Personalisation, right: Personalisation): boolean {
  return (
    left.displayName === right.displayName &&
    left.occupation === right.occupation &&
    left.additionalContext === right.additionalContext &&
    left.traits.length === right.traits.length &&
    left.traits.every((trait, index) => trait === right.traits[index])
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6">
      <div>
        <p id={`${id}-label`} className="text-sm font-medium text-[var(--text-primary)]">
          {label}
        </p>
        <p
          id={`${id}-description`}
          className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]"
        >
          {description}
        </p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        className="mt-1 shrink-0"
      />
    </div>
  );
}

export function SettingsCustomizationPage() {
  const { data } = useCurrentUser();
  const queryClient = useQueryClient();
  const {
    codeWrap,
    setCodeWrap,
    autoOpenArtifacts,
    setAutoOpenArtifacts,
    invertSend,
    setInvertSend,
  } = useTheme();

  const [name, setName] = useState('');
  const [occupation, setOccupation] = useState('');
  const [traitDraft, setTraitDraft] = useState('');
  const [traits, setTraits] = useState<string[]>([]);
  const [context, setContext] = useState('');
  const [saved, setSaved] = useState(false);

  // Hydrate once the preferences arrive.
  useEffect(() => {
    if (!data) return;
    setName(data.preferences.displayName ?? '');
    setOccupation(data.preferences.occupation ?? '');
    setTraits(data.preferences.traits ?? []);
    setContext(data.preferences.additionalContext ?? '');
  }, [data]);

  // What Save would send, and what is stored: Save stays off until they differ.
  const draft: Personalisation = {
    displayName: name.trim() || null,
    occupation: occupation.trim() || null,
    traits,
    additionalContext: context.trim() || null,
  };
  const stored: Personalisation | null = data
    ? {
        displayName: data.preferences.displayName?.trim() || null,
        occupation: data.preferences.occupation?.trim() || null,
        traits: data.preferences.traits ?? [],
        additionalContext: data.preferences.additionalContext?.trim() || null,
      }
    : null;
  const dirty = stored !== null && !samePersonalisation(draft, stored);

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch('/me/preferences', patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  function addTrait(trait: string) {
    const value = trait.trim();
    if (!value || traits.includes(value) || traits.length >= 20) return;
    setTraits((current) => [...current, value]);
    setTraitDraft('');
  }

  function handleTraitKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (!traitDraft.trim()) return;
      event.preventDefault();
      addTrait(traitDraft);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Customize your assistant</h1>

      <div className="mt-6 flex flex-col gap-6">
        <div>
          <label htmlFor="name" className="mb-2 block text-sm font-medium">
            What should the assistant call you?
          </label>
          <CountedInput
            id="name"
            value={name}
            onChange={setName}
            placeholder="Enter your name"
            max={LIMITS.name}
          />
        </div>

        <div>
          <label htmlFor="occupation" className="mb-2 block text-sm font-medium">
            What do you do?
          </label>
          <CountedInput
            id="occupation"
            value={occupation}
            onChange={setOccupation}
            placeholder="Engineer, student, etc."
            max={LIMITS.occupation}
          />
        </div>

        <div>
          <label htmlFor="traits" className="mb-2 block text-sm font-medium">
            What traits should the assistant have?
          </label>
          <CountedInput
            id="traits"
            value={traitDraft}
            onChange={setTraitDraft}
            onKeyDown={handleTraitKey}
            placeholder="Type a trait and press Enter or Tab..."
            max={LIMITS.trait}
          />

          {traits.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {traits.map((trait) => (
                <button
                  key={trait}
                  type="button"
                  onClick={() => setTraits((current) => current.filter((entry) => entry !== trait))}
                  className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-foreground)]"
                >
                  {trait}
                  <span aria-hidden>×</span>
                </button>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {SUGGESTED_TRAITS.filter((trait) => !traits.includes(trait)).map((trait) => (
              <button
                key={trait}
                type="button"
                onClick={() => addTrait(trait)}
                className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-control-alt)] px-2.5 py-1 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              >
                {trait}
                <Plus className="size-3" />
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="context" className="mb-2 block text-sm font-medium">
            Anything else it should know about you?
          </label>
          <CountedInput
            id="context"
            value={context}
            onChange={setContext}
            placeholder="Interests, values, or preferences to keep in mind"
            max={LIMITS.context}
            multiline
          />
        </div>

        <div className="flex items-center justify-end gap-3">
          <span role="status" className="text-xs text-[var(--success)]">
            {saved ? 'Saved' : ''}
          </span>
          {save.isError && (
            <span role="alert" className="text-xs text-[var(--danger)]">
              Your preferences could not be saved. Try again.
            </span>
          )}
          <Button
            variant="accent"
            disabled={save.isPending || !dirty}
            onClick={() => save.mutate({ ...draft })}
          >
            Save Preferences
          </Button>
        </div>
      </div>

      <Section title="Appearance">
        <AppearanceRow />
      </Section>

      <Section title="Behavior Options">
        <ToggleRow
          label="Invert Send/New Line Behavior"
          description="When enabled, Enter starts a new line and Cmd/Ctrl + Enter sends. When disabled, Enter sends and Shift + Enter starts a new line. Saved in this browser."
          checked={invertSend}
          onChange={setInvertSend}
        />
      </Section>

      <Section title="Visual Options">
        <ToggleRow
          label="Wrap Long Code Lines"
          description="Wrap long lines in code blocks instead of scrolling them sideways."
          checked={codeWrap}
          onChange={setCodeWrap}
        />
        <ToggleRow
          label="Open artifacts automatically"
          description="On wide screens, open the artifact panel beside the conversation when a reply starts writing a page, image, diagram or document, so you can watch it being written."
          checked={autoOpenArtifacts}
          onChange={setAutoOpenArtifacts}
        />
      </Section>
    </div>
  );
}
