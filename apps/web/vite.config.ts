import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.VITE_API_PROXY ?? 'http://localhost:3080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Same-origin proxy keeps session cookies simple in development and
    // mirrors the reverse proxy used in production.
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: false,
      },
    },
  },
  // CI exercises the production bundle with `vite preview`; keep its topology
  // identical to development instead of letting /api requests hit static 404s.
  preview: {
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Route splitting otherwise fragments shared startup code into dozens
          // of requests. Group only modules already needed by the initial page;
          // do not eagerly bundle dependencies exclusive to deferred routes.
          groups: [{ name: 'initial-shared', tags: ['$initial'], minShareCount: 2 }],
        },
      },
    },
  },
});
