import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { DocumentBranding } from '~/components/brand/document-branding';
import { activateLocale, I18nProvider, initialLocale } from '~/lib/i18n';
import { listenForInstallPrompt } from '~/lib/install-prompt';
import { clearReadOnlyRefusalsWhenLifted } from '~/lib/read-only-refusals';
import { InstanceThemeSync } from '~/providers/instance-theme-sync';
import { ThemeProvider } from '~/providers/theme-provider';
import { router } from '~/router';
import './styles/global.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
});

// A change refused while read-only stops saying so once it is off (#308).
clearReadOnlyRefusalsWhenLifted(queryClient);

// The browser offers installing once, early; keep it for Settings (#400).
listenForInstallPrompt();

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

const root = createRoot(container);

// The language shown last time is loaded before the first render, so a person
// who reads Spanish never sees English flash first, and nobody sees message
// keys: every catalog, English included, is a chunk fetched here (one small
// request, nothing painted meanwhile). It never rejects: a catalog that cannot
// be loaded falls back to English, and then to the keys.
void activateLocale(initialLocale()).finally(() =>
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ThemeProvider>
            <InstanceThemeSync />
            <DocumentBranding router={router} />
            <RouterProvider router={router} />
            <Toaster theme="dark" position="top-right" />
          </ThemeProvider>
        </I18nProvider>
      </QueryClientProvider>
    </StrictMode>,
  ),
);
