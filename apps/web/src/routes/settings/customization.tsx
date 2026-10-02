import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { type KeyboardEvent, useEffect, useState } from 'react';
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
  return (
    <div className="flex items-start justify-between gap-6">
      <div>
        <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
        <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-1 shrink-0" />
    </div>
  );
}

export function SettingsCustomizationPage() {
  const { data } = useCurrentUser();
  const queryClient = useQueryClient();
  const { codeWrap, setCodeWrap } = useTheme();

  const [name, setName] = useState('');
  const [occupation, setOccupation] = useState('');
  const [traitDraft, setTraitDraft] = useState('');
  const [traits, setTraits] = useState<string[]>([]);
  const [context, setContext] = useState('');
  const [saved, setSaved] = useState(false);
  const [hidePersonalInfo, setHidePersonalInfo] = useState(false);
  const [invertSend, setInvertSend] = useState(false);

  // Hydrate once the preferences arrive.
  useEffect(() => {
    if (!data) return;
    setName(data.preferences.displayName ?? '');
    setOccupation(data.preferences.occupation ?? '');
    setTraits(data.preferences.traits ?? []);
    setContext(data.preferences.additionalContext ?? '');
  }, [data]);

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
          {saved && <span className="text-xs text-[var(--success)]">Saved</span>}
          <Button
            variant="accent"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                displayName: name.trim() || null,
                occupation: occupation.trim() || null,
                traits,
                additionalContext: context.trim() || null,
              })
            }
          >
            Save Preferences
          </Button>
        </div>
      </div>

      <Section title="Behavior Options">
        <ToggleRow
          label="Invert Send/New Line Behavior"
          description="When enabled, use Enter for newlines and a modifier key + Enter to send messages. When disabled, use Enter to send and Shift + Enter for new lines."
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
          label="Hide Personal Information"
          description="Hides your name and email from the UI."
          checked={hidePersonalInfo}
          onChange={setHidePersonalInfo}
        />
      </Section>
    </div>
  );
}
