// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatDate,
  formatFileSize,
  formatList,
  formatNumber,
  formatRelativeTime,
} from '../../src/lib/i18n/format';
import { activateLocale } from '../../src/lib/i18n/state';

// One formatter module, driven by the current locale unless a call names one.

const D = new Date(Date.UTC(2026, 9, 14, 15, 30, 0));
const utc = { timeZone: 'UTC' };

beforeEach(async () => {
  await activateLocale('en');
});

describe('formatNumber', () => {
  it('groups digits for the locale', () => {
    expect(formatNumber(1234567.891, { locale: 'en' })).toBe('1,234,567.891');
    expect(formatNumber(1234567.891, { locale: 'es' })).toBe(
      new Intl.NumberFormat('es').format(1234567.891),
    );
    expect(formatNumber(1234567.891, { locale: 'de' })).toBe('1.234.567,891');
  });

  it('has integer, percent and compact styles and fraction limits', () => {
    expect(formatNumber(2.7, { style: 'integer' })).toBe('3');
    expect(formatNumber(0.256, { style: 'percent' })).toBe('26%');
    expect(formatNumber(15_300, { style: 'compact' })).toBe('15K');
    expect(formatNumber(1, { minimumFractionDigits: 2 })).toBe('1.00');
    expect(formatNumber(1.23456, { maximumFractionDigits: 1 })).toBe('1.2');
  });

  it('follows the language the app is showing', async () => {
    await activateLocale('ar');
    expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat('ar').format(1234.5));
    await activateLocale('es');
    expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat('es').format(1234.5));
    // A pseudo-locale formats like the language it imitates.
    await activateLocale('ar-XB');
    expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat('ar').format(1234.5));
  });
});

describe('formatDate', () => {
  it('writes a date, a time or both', () => {
    expect(formatDate(D, 'long', { locale: 'en', ...utc })).toBe('October 14, 2026');
    expect(formatDate(D, 'short', { locale: 'en', ...utc })).toBe('10/14/26');
    expect(formatDate(D, 'medium', { locale: 'en', ...utc })).toBe('Oct 14, 2026');
    expect(formatDate(D, 'time', { locale: 'en', ...utc })).toBe('3:30 PM');
    expect(formatDate(D, 'dateTime', { locale: 'en', ...utc })).toBe('Oct 14, 2026, 3:30 PM');
    expect(formatDate(D, 'long', { locale: 'es', ...utc })).toBe('14 de octubre de 2026');
  });

  it('accepts an ISO string or a timestamp', () => {
    expect(formatDate('2026-10-14T15:30:00Z', 'long', { locale: 'en', ...utc })).toBe(
      'October 14, 2026',
    );
    expect(formatDate(D.getTime(), 'long', { locale: 'en', ...utc })).toBe('October 14, 2026');
  });

  it('returns what it was given when it is not a date, instead of "Invalid Date"', () => {
    expect(formatDate('yesterday-ish', 'long')).toBe('yesterday-ish');
    expect(formatDate(Number.NaN, 'long')).toBe('NaN');
  });

  it('follows the language the app is showing', async () => {
    await activateLocale('es');
    expect(formatDate(D, 'long', utc)).toBe('14 de octubre de 2026');
  });
});

describe('formatRelativeTime', () => {
  const now = D.getTime();
  const ago = (seconds: number) => new Date(now - seconds * 1_000);
  const options = { locale: 'en', now };

  it('says just now, minutes, hours and days, past and future', () => {
    expect(formatRelativeTime(ago(10), options)).toBe('now');
    expect(formatRelativeTime(ago(5 * 60), options)).toBe('5 minutes ago');
    expect(formatRelativeTime(ago(3 * 3_600), options)).toBe('3 hours ago');
    expect(formatRelativeTime(ago(86_400), options)).toBe('yesterday');
    expect(formatRelativeTime(ago(3 * 86_400), options)).toBe('3 days ago');
    expect(formatRelativeTime(ago(-2 * 3_600), options)).toBe('in 2 hours');
    expect(formatRelativeTime(ago(-86_400), options)).toBe('tomorrow');
  });

  it('uses the date past a month', () => {
    expect(formatRelativeTime(ago(60 * 86_400), { ...options, ...utc })).toBe('Aug 15, 2026');
  });

  it('is in the language asked for', () => {
    expect(formatRelativeTime(ago(3 * 3_600), { locale: 'es', now })).toBe('hace 3 horas');
  });

  it('returns what it was given when it is not a date', () => {
    expect(formatRelativeTime('soon', options)).toBe('soon');
  });
});

describe('formatList', () => {
  it('joins in the locale', () => {
    expect(formatList(['A', 'B', 'C'], { locale: 'en' })).toBe('A, B, and C');
    expect(formatList(['A', 'B'], { locale: 'en' })).toBe('A and B');
    expect(formatList(['A', 'B', 'C'], { locale: 'es' })).toBe('A, B y C');
    expect(formatList(['A', 'B', 'C'], { locale: 'en', type: 'disjunction' })).toBe('A, B, or C');
    expect(formatList([], { locale: 'en' })).toBe('');
  });
});

describe('formatFileSize', () => {
  it('counts in 1,024s with the unit short', () => {
    expect(formatFileSize(0, { locale: 'en' })).toBe('0 byte');
    expect(formatFileSize(512, { locale: 'en' })).toBe('512 byte');
    expect(formatFileSize(1024, { locale: 'en' })).toBe('1 kB');
    expect(formatFileSize(1536, { locale: 'en' })).toBe('1.5 kB');
    expect(formatFileSize(10 * 1024 * 1024, { locale: 'en' })).toBe('10 MB');
    expect(formatFileSize(5 * 1024 ** 3, { locale: 'en' })).toBe('5 GB');
    expect(formatFileSize(2 * 1024 ** 5, { locale: 'en' })).toBe('2,048 TB');
  });

  it('uses the locale digits and separators, and survives a bad value', () => {
    expect(formatFileSize(1536, { locale: 'es' })).toBe(
      new Intl.NumberFormat('es', {
        style: 'unit',
        unit: 'kilobyte',
        unitDisplay: 'short',
        maximumFractionDigits: 1,
      }).format(1.5),
    );
    expect(formatFileSize(Number.NaN)).toBe('NaN');
    expect(formatFileSize(-5)).toBe('-5');
  });
});
