import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, MessageSquare, Sparkles, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Input, Textarea } from '~/components/ui/input';
import { Spinner } from '~/components/ui/spinner';
import { api } from '~/lib/api-client';
import { cn } from '~/lib/utils';

/** Suggestions, so the trait step is a choice rather than a blank field. */
const SUGGESTED_TRAITS = [
  'concise',
  'thorough',
  'formal',
  'casual',
  'encouraging',
  'direct',
  'patient',
  'technical',
];

interface Draft {
  displayName: string;
  occupation: string;
  traits: string[];
  additionalContext: string;
}

const STEPS = [
  {
    id: 'name',
    icon: UserRound,
    title: 'What should we call you?',
    description:
      'Used when a reply addresses you directly. Your account name is used if you leave this blank.',
  },
  {
    id: 'traits',
    icon: Sparkles,
    title: 'How should replies sound?',
    description:
      'Pick any that fit. These shape the tone of every answer, and you can change them whenever you like.',
  },
  {
    id: 'context',
    icon: MessageSquare,
    title: 'Anything else worth knowing?',
    description:
      'Preferences about format, subject matter, or anything a colleague would find useful to know before helping you.',
  },
] as const;

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me', 'onboarding'] }),
  });

  const isLast = step === STEPS.length - 1;
  const current = STEPS[step];
  if (!current) return null;
  const Icon = current.icon;

  function toggleTrait(trait: string) {
    setDraft((value) => ({
      ...value,
      traits: value.traits.includes(trait)
        ? value.traits.filter((entry) => entry !== trait)
        : [...value.traits, trait].slice(0, 20),
    }));
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--bg-app)] px-4 py-10">
      <div className="w-full max-w-5xl overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
        <div className="grid min-h-[26rem] md:grid-cols-[1fr_1.15fr]">
          {/* Context stays put while the question changes, so the wizard reads
              as one task rather than a series of unrelated screens. */}
          <div className="flex flex-col justify-between gap-8 border-[var(--border-subtle)] border-b p-8 md:border-r md:border-b-0 md:p-10">
            <div>
              <span className="flex size-12 items-center justify-center rounded-xl bg-[var(--accent-soft)]">
                <Icon className="size-6 text-[var(--accent-bright)]" aria-hidden="true" />
              </span>
              <h1 className="mt-6 font-semibold text-2xl leading-tight">{current.title}</h1>
              <p className="mt-3 text-[var(--text-muted)] leading-relaxed">{current.description}</p>
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
                Step {step + 1} of {STEPS.length}
              </span>
            </div>
          </div>

          <div className="flex flex-col justify-between gap-8 p-8 md:p-10">
            <div className="flex flex-1 flex-col justify-center gap-5">
              {current.id === 'name' && (
                <>
                  <label className="flex flex-col gap-1.5 text-sm" htmlFor="wizard-name">
                    <span className="font-medium">Name</span>
                    <Input
                      id="wizard-name"
                      className="h-11"
                      autoFocus
                      value={draft.displayName}
                      maxLength={120}
                      placeholder="Alex"
                      onChange={(event) =>
                        setDraft((value) => ({ ...value, displayName: event.target.value }))
                      }
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm" htmlFor="wizard-occupation">
                    <span className="font-medium">What do you do?</span>
                    <Input
                      id="wizard-occupation"
                      className="h-11"
                      value={draft.occupation}
                      maxLength={200}
                      placeholder="Research administrator"
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
                        {trait}
                      </button>
                    );
                  })}
                </div>
              )}

              {current.id === 'context' && (
                <label className="flex flex-col gap-1.5 text-sm" htmlFor="wizard-context">
                  <span className="font-medium">Notes</span>
                  <Textarea
                    id="wizard-context"
                    rows={9}
                    value={draft.additionalContext}
                    maxLength={4_000}
                    placeholder="I prefer short answers with examples, and I work mostly in TypeScript."
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
                  <ArrowLeft />
                  Back
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={finish.isPending}
                  onClick={() => finish.mutate(true)}
                >
                  Skip for now
                </Button>
              )}

              <Button
                variant="primary"
                disabled={finish.isPending}
                onClick={() => (isLast ? finish.mutate(false) : setStep((value) => value + 1))}
              >
                {finish.isPending && <Spinner />}
                {isLast ? 'Finish' : 'Continue'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
