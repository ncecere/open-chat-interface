import { Button } from '~/components/ui/button';
import { useT } from '~/lib/i18n';
import { useInstallPrompt } from '~/lib/install-prompt';

/**
 * "Install the app", on Settings → Customization, only while the browser has
 * offered installing (`beforeinstallprompt`). Nothing at all is shown
 * otherwise: a browser that cannot offer it (Safari, Firefox) or an app
 * already installed has nothing to press; the docs cover Add to Home Screen.
 */
export function InstallAppSection() {
  const t = useT();
  const { canInstall, install } = useInstallPrompt();
  if (!canInstall) return null;

  return (
    <section className="mt-12">
      <h2 className="text-xl font-bold">{t('settings.install.title')}</h2>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <p className="text-sm leading-relaxed text-[var(--text-muted)]">
          {t('settings.install.description')}
        </p>
        <Button variant="accent" className="shrink-0 self-start" onClick={() => void install()}>
          {t('settings.install.button')}
        </Button>
      </div>
    </section>
  );
}
