import { translate } from '~/lib/i18n';

/**
 * A readable name for a browser's user agent, for Settings → Account →
 * Devices: "Firefox on Windows", "Safari on iPhone". Deliberately coarse;
 * anything unrecognised is "Unknown browser" / "unknown device" rather than
 * the raw string.
 */
const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bCriOS\/|\bChrome\/|\bChromium\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

/** Browser and system names are product names and stay as they are; the words around them are translated. */
export function describeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return translate('settings.devices.unknown');
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && system) return translate('settings.devices.browserOn', { browser, system });
  if (browser) return browser;
  if (system) return translate('settings.devices.unknownBrowserOn', { system });
  return translate('settings.devices.unknown');
}
