import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, MessageSquare, Sparkles, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Input, Textarea } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { type MessageKey, type Translate, useT } from '~/lib/i18n';
import { SUGGESTED_TRAITS, withTrait } from '~/lib/traits';
import { cn } from '~/lib/utils';

interface Draft {
  displayName: string;
  occupation: string;
  traits: string[];
  additionalContext: string;
}

const STEPS = [
  { id: 'name', icon: UserRound },
  { id: 'traits', icon: Sparkles },
  { id: 'context', icon: MessageSquare },
] as const;

/** What each step asks, in the language showing now. */
function stepText(id: (typeof STEPS)[number]['id'], t: Translate) {
  switch (id) {
    case 'name':
      return { title: t('onboarding.name.title'), description: t('onboarding.name.description') };
    case 'traits':
      return {
        title: t('onboarding.traits.title'),
        description: t('onboarding.traits.description'),
      };
    case 'context':
      return {
        title: t('onboarding.context.title'),
        description: t('onboarding.context.description'),
      };
  }
}

/**
 * A suggested trait as the person reads it. What is saved is the English word
 * (`value`): it goes into the assistant's instructions, so only the label shown
 * is translated, and a trait this list does not know is shown as it is.
 */
const TRAIT_LABELS: Record<string, MessageKey> = {
  concise: 'onboarding.trait.concise',
  thorough: 'onboarding.trait.thorough',
  formal: 'onboarding.trait.formal',
  casual: 'onboarding.trait.casual',
  encouraging: 'onboarding.trait.encouraging',
  direct: 'onboarding.trait.direct',
  patient: 'onboarding.trait.patient',
  technical: 'onboarding.trait.technical',
};

/**
 * A short introduction that personalizes replies.
 *
 * Split across steps rather than presented as one form: each question is
 * optional, and a single page of optional fields reads as a chore that invites
 * being ignored. One question at a time is answerable.
 *
 * Everything collected feeds the system prompt, which is the only reason to
 * ask at all.
 */
export function IntroductionWizard() {
  const t = useT();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({
    displayName: '',
    occupation: '',
    traits: [],
    additionalContext: '',
  });

  const finish = useMutation({
    mutationFn: (skip: boolean) =>
      skip
        ? api.post('/me/onboarding/skip')
        : api.post('/me/onboarding/complete', {
            displayName: draft.displayName.trim() || null,
            occupation: draft.occupation.trim() || null,
            traits: draft.traits,
            additionalContext: draft.additionalContext.trim() || null,
          }),
    // All of ['me'], not only the onboarding state: the home page's greeting
    // reads the name given here from /me (#315).
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];
  if (!current) return null;
  const Icon = current.icon;
  const text = stepText(current.id, t);

  function toggleTrait(trait: string) {
    setDraft((value) => ({
      ...value,
      traits: value.traits.includes(trait)
        ? value.traits.filter((entry) => entry !== trait)
        : withTrait(value.traits, trait),
    }));
  }

  return (
    // On phones the card starts at the top and keeps one height, so its edge
    // and Back/Continue stay put from step to step (#107); centred on wider
    // screens, where every step fits the same card.
    <div className="flex min-h-dvh items-start justify-center bg-[var(--bg-app)] px-4 py-10 md:items-center">
      <div className="w-full max-w-5xl overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
        <div className="grid min-h-[calc(100dvh-5rem)] grid-rows-[auto_1fr] md:min-h-[26rem] md:grid-cols-[1fr_1.15fr] md:grid-rows-none">
          {/* Context stays put while the question changes, so the wizard reads
              as one task rather than a series of unrelated screens. */}
          <div className="flex flex-col justify-between gap-8 border-[var(--border-subtle)] border-b p-8 md:border-e md:border-b-0 md:p-10">
            <div>
              <span className="flex size-12 items-center justify-center rounded-xl bg-[var(--accent-soft)]">
                <Icon className="size-6 text-[var(--accent-bright)]" aria-hidden="true" />
              </span>
              <h1 className="mt-6 font-semibold text-2xl leading-tight">{text.title}</h1>
              <p className="mt-3 text-[var(--text-muted)] leading-relaxed">{text.description}</p>
            </div>

            <div className="flex items-center gap-2" aria-hidden="true">
              {STEPS.map((entry, index) => (
                <span
                  key={entry.id}
                  className={cn(
                    'h-1.5 rounded-full transition-all',
                    index === step
                      ? 'w-6 bg-[var(--accent)]'
                      : index < step
                        ? 'w-1.5 bg-[var(--accent)]/50'
                        : 'w-1.5 bg-[var(--bg-segment-track)]',
                  )}
                />
              ))}
              <span className="sr-only">
                {t('onboarding.stepOf', { step: step + 1, total: STEPS.length })}
              </span>
            </div>
          </div>

          <div className="flex flex-col justify-between gap-8 p-8 md:p-10">
            <div className="flex flex-1 flex-col justify-start gap-5 md:justify-center">
              {current.id === 'name' && (
                <>
                  <label className="flex flex-col gap-1.5 text-sm" htmlFor="wizard-name">
                    <span className="font-medium">{t('onboarding.name.label')}</span>
                    <Input
                      id="wizard-name"
                      className="h-11"
                      autoFocus
                      value={draft.displayName}
                      maxLength={120}
                      // Not a name, which read as one already filled in (#107).
                      placeholder={t('onboarding.name.placeholder')}
                      onChange={(event) =>
                        setDraft((value) => ({ ...value, displayName: event.target.value }))
                      }
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm" htmlFor="wizard-occupation">
                    <span className="font-medium">{t('onboarding.name.occupationLabel')}</span>
                    <Input
                      id="wizard-occupation"
                      className="h-11"
                      value={draft.occupation}
                      maxLength={200}
                      placeholder={t('onboarding.name.occupationPlaceholder')}
                      onChange={(event) =>
                        setDraft((value) => ({ ...value, occupation: event.target.value }))
                      }
                    />
                  </label>
                </>
              )}

              {current.id === 'traits' && (
                <div className="flex flex-wrap gap-2">
                  {SUGGESTED_TRAITS.map((trait) => {
                    const selected = draft.traits.includes(trait);
                    return (
                      <button
                        key={trait}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleTrait(trait)}
                        className={cn(
                          'flex items-center gap-1.5 rounded-full px-4 py-2.5 text-sm capitalize transition-colors',
                          selected
                            ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                            : 'bg-[var(--bg-control-alt)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                        )}
                      >
                        {selected && <Check className="size-3.5" aria-hidden="true" />}
                        {TRAIT_LABELS[trait] ? t(TRAIT_LABELS[trait]) : trait}
                      </button>
                    );
                  })}
                </div>
              )}

              {current.id === 'context' && (
                <label className="flex flex-col gap-1.5 text-sm" htmlFor="wizard-context">
                  <span className="font-medium">{t('onboarding.context.label')}</span>
                  <Textarea
                    id="wizard-context"
                    rows={9}
                    value={draft.additionalContext}
                    maxLength={4_000}
                    placeholder={t('onboarding.context.placeholder')}
                    onChange={(event) =>
                      setDraft((value) => ({ ...value, additionalContext: event.target.value }))
                    }
                  />
                </label>
              )}
            </div>

            <div className="flex items-center justify-between gap-3">
              {step > 0 ? (
                <Button variant="ghost" size="sm" onClick={() => setStep((value) => value - 1)}>
                  <ArrowLeft className="rtl:-scale-x-100" />
                  {t('onboarding.back')}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={finish.isPending}
                  onClick={() => finish.mutate(true)}
                >
                  {t('onboarding.skip')}
                </Button>
              )}

              <Button
                variant="primary"
                disabled={finish.isPending}
                onClick={() => (isLast ? finish.mutate(false) : setStep((value) => value + 1))}
              >
                {finish.isPending && <Spinner />}
                {isLast ? t('onboarding.finish') : t('onboarding.continue')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
