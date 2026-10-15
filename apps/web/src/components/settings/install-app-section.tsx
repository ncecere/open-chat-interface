import { Button } from '~/components/ui/button';
import { useInstallPrompt } from '~/lib/install-prompt';

/**
 * "Install the app", on Settings → Customization, only while the browser has
 * offered installing (`beforeinstallprompt`). Nothing at all is shown
 * otherwise: a browser that cannot offer it (Safari, Firefox) or an app
 * already installed has nothing to press; the docs cover Add to Home Screen.
 */
export function InstallAppSection() {
  const { canInstall, install } = useInstallPrompt();
  if (!canInstall) return null;

  return (
    <section className="mt-12">
      <h2 className="text-xl font-bold">Install the app</h2>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <p className="text-sm leading-relaxed text-[var(--text-muted)]">
          Add this site to your home screen or desktop, so it opens in its own window without the
          browser's address bar. It still needs a network connection: nothing is saved for offline
          use.
        </p>
        <Button variant="accent" className="shrink-0 self-start" onClick={() => void install()}>
          Install
        </Button>
      </div>
    </section>
  );
}
