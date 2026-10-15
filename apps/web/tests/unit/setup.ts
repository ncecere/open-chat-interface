import { activateLocale } from '../../src/lib/i18n/state';

// Global setup for the web unit suite (vite.config.ts, `test.setupFiles`).
//
// Every catalog, English included, is a dynamic import that the app awaits
// before its first render (main.tsx). A test renders components directly, so
// without this `useT()` would return keys. English is activated here, before
// any test file runs (a setup file may await), so a test never awaits a load
// and `useT()` / `translate()` return the real English strings.
//
// A test that switches language still awaits `activateLocale('es')` itself.
await activateLocale('en');
