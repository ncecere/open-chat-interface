import type { ThemeMode } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Monitor, Moon, Sun } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useState } from 'react';
import { useReportUnsaved } from '~/components/admin/unsaved-changes';
import { InstallAppSection } from '~/components/settings/install-app-section';
import { LanguagePicker } from '~/components/settings/language-picker';
import { TraitChips, traitChange } from '~/components/settings/trait-chips';
import { Button } from '~/components/ui/button';
import { Switch } from '~/components/ui/switch';
import { useCurrentUser } from '~/hooks/use-current-user';
import { api, apiErrorMessage } from '~/lib/api-client';
import { type MessageKey, useT } from '~/lib/i18n';
import { useReadOnlyLock } from '~/lib/read-only';
import { withTrait } from '~/lib/traits';
import { cn } from '~/lib/utils';
import { useTheme } from '~/providers/theme-provider';

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
  const t = useT();
  // The limit is heard with the field, not only seen beside it (#310).
  const countId = `${id}-count`;
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
          aria-describedby={countId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={cn(shared, 'resize-none py-2.5 pb-8')}
        />
      ) : (
        <input
          id={id}
          maxLength={max}
          aria-describedby={countId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className={cn(shared, 'h-11 pe-16')}
        />
      )}
      <span
        id={countId}
        className="pointer-events-none absolute bottom-2.5 end-3 text-xs text-[var(--text-muted)]"
      >
        {value.length}/{max}
        <span className="sr-only"> {t('settings.customization.characters')}</span>
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
  { value: 'light', label: 'settings.customization.light', icon: Sun },
  { value: 'dark', label: 'settings.customization.dark', icon: Moon },
  { value: 'system', label: 'settings.customization.system', icon: Monitor },
] as const satisfies readonly { value: string; label: MessageKey; icon: unknown }[];

/**
 * Light, Dark or System, the same choice as the chat's appearance menu and
 * kept per browser. Native radio buttons, so arrow keys and screen readers
 * work as they do everywhere else.
 */
function AppearanceRow() {
  const t = useT();
  const { theme, setTheme } = useTheme();
  const id = useId();
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div>
        <p id={`${id}-label`} className="text-sm font-medium text-[var(--text-primary)]">
          {t('settings.customization.appearance')}
        </p>
        <p
          id={`${id}-description`}
          className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]"
        >
          {t('settings.customization.appearanceDescription')}
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
            {t(option.label)}
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
  const t = useT();
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
  const [traitStatus, setTraitStatus] = useState('');
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
  // Leaving with an edit not saved asks first (#314).
  useReportUnsaved(dirty);

  // Saving is refused while read-only, however much was changed (#353).
  const lock = useReadOnlyLock();
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch('/me/preferences', patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  function changeTraits(next: string[]) {
    setTraitStatus(traitChange(traits, next));
    setTraits(next);
  }

  function addTrait(trait: string) {
    if (!trait.trim()) return;
    // The same suggestions as the introduction; an opposite is replaced (#96).
    changeTraits(withTrait(traits, trait));
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
      <h1 className="text-2xl font-bold">{t('settings.customization.title')}</h1>

      <div className="mt-6 flex flex-col gap-6">
        <div>
          <label htmlFor="name" className="mb-2 block text-sm font-medium">
            {t('settings.customization.nameLabel')}
          </label>
          <CountedInput
            id="name"
            value={name}
            onChange={setName}
            placeholder={t('settings.customization.namePlaceholder')}
            max={LIMITS.name}
          />
        </div>

        <div>
          <label htmlFor="occupation" className="mb-2 block text-sm font-medium">
            {t('settings.customization.occupationLabel')}
          </label>
          <CountedInput
            id="occupation"
            value={occupation}
            onChange={setOccupation}
            placeholder={t('settings.customization.occupationPlaceholder')}
            max={LIMITS.occupation}
          />
        </div>

        <div>
          <label htmlFor="traits" className="mb-2 block text-sm font-medium">
            {t('settings.customization.traitsLabel')}
          </label>
          <CountedInput
            id="traits"
            value={traitDraft}
            onChange={setTraitDraft}
            onKeyDown={handleTraitKey}
            placeholder={t('settings.customization.traitsPlaceholder')}
            max={LIMITS.trait}
          />

          <TraitChips traits={traits} onChange={changeTraits} inputId="traits" />
          {/* What a press or Enter did, as the chips' changes are not otherwise heard (#299). */}
          <p role="status" className="sr-only">
            {traitStatus}
          </p>
        </div>

        <div>
          <label htmlFor="context" className="mb-2 block text-sm font-medium">
            {t('settings.customization.contextLabel')}
          </label>
          <CountedInput
            id="context"
            value={context}
            onChange={setContext}
            placeholder={t('settings.customization.contextPlaceholder')}
            max={LIMITS.context}
            multiline
          />
        </div>

        <div className="flex items-center justify-end gap-3">
          <span role="status" className="text-xs text-[var(--success)]">
            {saved ? t('settings.customization.saved') : ''}
          </span>
          {/* An edit looked applied until Save was pressed (#314). */}
          {dirty && !save.isPending && (
            <span className="text-xs text-[var(--text-muted)]">
              {t('settings.customization.notSaved')}
            </span>
          )}
          {save.isError && (
            <span role="alert" className="text-xs text-[var(--danger)]">
              {/* A read-only refusal gives its reason, not "Try again" (#159). */}
              {apiErrorMessage(save.error, t('settings.customization.saveFailed'))}
            </span>
          )}
          <Button
            variant="accent"
            locked={lock.title}
            disabled={save.isPending || !dirty}
            onClick={() => save.mutate({ ...draft })}
          >
            {t('settings.customization.save')}
          </Button>
        </div>
      </div>

      <LanguagePicker />

      <Section title={t('settings.customization.appearance')}>
        <AppearanceRow />
      </Section>

      <Section title={t('settings.customization.behavior')}>
        <ToggleRow
          label={t('settings.customization.invertSend')}
          description={t('settings.customization.invertSendDescription')}
          checked={invertSend}
          onChange={setInvertSend}
        />
      </Section>

      <Section title={t('settings.customization.visual')}>
        <ToggleRow
          label={t('settings.customization.wrapCode')}
          description={t('settings.customization.wrapCodeDescription')}
          checked={codeWrap}
          onChange={setCodeWrap}
        />
        <ToggleRow
          label={t('settings.customization.autoArtifacts')}
          description={t('settings.customization.autoArtifactsDescription')}
          checked={autoOpenArtifacts}
          onChange={setAutoOpenArtifacts}
        />
      </Section>

      <InstallAppSection />
    </div>
  );
}
