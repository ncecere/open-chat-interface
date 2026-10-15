import { activateLocale } from '../../src/lib/i18n/state';

/**
 * Loads every catalog now, leaves English active. A catalog is a dynamic import
 * (real I/O, however fast), so a test that switches language and then waits a
 * fixed number of ticks (`settle()`) can race it under load. With the catalogs
 * already in memory the switch is a few microtasks, so it cannot.
 */
export async function preloadCatalogs(): Promise<void> {
  await activateLocale('es');
  await activateLocale('ar');
  await activateLocale('en');
}
