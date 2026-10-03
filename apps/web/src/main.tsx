import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { DocumentBranding } from '~/components/brand/document-branding';
import { InstanceThemeSync } from '~/providers/instance-theme-sync';
import { ThemeProvider } from '~/providers/theme-provider';
import { router } from '~/router';
import './styles/global.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <InstanceThemeSync />
        <DocumentBranding router={router} />
        <RouterProvider router={router} />
        <Toaster theme="dark" position="top-right" />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
