import { Toaster } from 'sonner';
import { useLocale, useT } from '~/lib/i18n';

/**
 * The app's notices (sonner), in the language and direction showing: the
 * region is named for a screen reader ("Notifications"), the text reads
 * right to left in Arabic and the stack sits in the corner where reading
 * ends, which is the left one there.
 */
export function AppToaster() {
  const t = useT();
  const { dir } = useLocale();
  return (
    <Toaster
      theme="dark"
      position={dir === 'rtl' ? 'top-left' : 'top-right'}
      dir={dir}
      containerAriaLabel={t('ui.toaster.label')}
    />
  );
}
