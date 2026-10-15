import { isSupportedLocale } from '@oci/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import { toast } from 'sonner';
import { Select, type SelectOption } from '~/components/ui/select';
import { type CurrentUser, type UserPreferences, useCurrentUser } from '~/hooks/use-current-user';
import { api, apiErrorMessage } from '~/lib/api-client';
import { activateLocale, translate, useLocale, useT } from '~/lib/i18n';
import { useReadOnlyLock } from '~/lib/read-only';
import { isPseudoLocale, LOCALES, type LocaleTag, PSEUDO_LOCALES } from '~/locales';

/**
 * Settings → Customization → Language (v0.14, #397).
 *
 * Saved to the server, so it follows the person to every device, and applied
 * as soon as the server has it. "Automatic" clears the choice: the instance's
 * default applies, or else the browser's language. The picker offers what the
 * instance enabled; a person whose own language was switched off since sees
 * Automatic, and the saved choice is kept in case it is switched on again.
 * Pseudo-locales (test builds only) are a per-device choice and never saved.
 *
 * Each option is written in its own language, so someone who cannot read the
 * current language can still find theirs. A machine-drafted language says so.
 */
interface MeCache {
  user: CurrentUser;
  preferences: UserPreferences;
}

export function LanguagePicker() {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const lock = useReadOnlyLock();
  const { data } = useCurrentUser();
  const { locale, available, setPseudoLocale } = useLocale();

  const save = useMutation({
    mutationFn: (value: string | null) => api.patch('/me/preferences', { locale: value }),
    onSuccess: async (_response, value) => {
      // Straight into the cached profile, which the provider reads: the page
      // changes language now, and the refetch only confirms it.
      queryClient.setQueryData<MeCache | null>(['me'], (current) =>
        current ? { ...current, preferences: { ...current.preferences, locale: value } } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      // Switched here rather than left to the provider, so the confirmation
      // is in the language that was just chosen, not the one that was left.
      if (isSupportedLocale(value)) await activateLocale(value);
      toast.success(translate('settings.language.saved'));
    },
  });

  const real = available.filter((tag) => !isPseudoLocale(tag));
  // Nothing to choose between: English only, in a production build.
  if (available.length <= 1) return null;

  const saved = data?.preferences?.locale ?? null;
  const chosen: string = isPseudoLocale(locale)
    ? locale
    : saved && available.includes(saved as LocaleTag)
      ? saved
      : '';

  const options: SelectOption[] = [
    { value: '', label: t('settings.language.automatic') },
    ...available.map((tag) => ({
      value: tag,
      label: isPseudoLocale(tag) ? PSEUDO_LOCALES[tag].name : optionLabel(tag),
    })),
  ];

  function optionLabel(tag: Exclude<LocaleTag, 'en-XA' | 'ar-XB'>): string {
    const name = t(`language.name.${tag}`);
    return LOCALES[tag].beta ? t('language.optionBeta', { name }) : name;
  }

  function choose(value: string) {
    if (isPseudoLocale(value)) {
      setPseudoLocale(value);
      return;
    }
    if (value !== '' && !isSupportedLocale(value)) return;
    // Leaving a pseudo-locale on this device, whatever was chosen.
    setPseudoLocale(null);
    if (value === (saved ?? '')) return;
    save.mutate(value === '' ? null : value);
  }

  const current = isPseudoLocale(locale) ? null : LOCALES[locale];

  return (
    <section className="mt-12" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="text-xl font-bold">
        {t('settings.language.title')}
      </h2>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div>
          <p id={`${id}-description`} className="text-sm leading-relaxed text-[var(--text-muted)]">
            {t('settings.language.description')}
          </p>
          <p id={`${id}-hint`} className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">
            {t('settings.language.automaticHint')}{' '}
            {t('settings.language.available', { count: real.length })}
          </p>
          {current?.beta && (
            <p role="note" className="mt-2 text-sm leading-relaxed text-[var(--text-muted)]">
              {t('settings.language.betaNotice')}
            </p>
          )}
        </div>
        <div className="w-full shrink-0 sm:w-64">
          <Select
            id={id}
            aria-label={t('settings.language.title')}
            aria-describedby={`${id}-description`}
            value={chosen}
            options={options}
            disabled={save.isPending || lock.locked}
            onChange={choose}
          />
          {save.isError && (
            <p role="alert" className="mt-2 text-xs text-[var(--danger)]">
              {apiErrorMessage(save.error, t('settings.language.saveFailed'))}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
