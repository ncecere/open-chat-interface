/**
 * How far behind the application a conformance report is. A minor release changes the interface,
 * so a report more than one minor release behind describes a product that no longer exists.
 */

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  if (!match) throw new Error(`Not a version: "${text}"`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Minor releases the report is behind the application: 0 when it is the same minor or newer.
 * A different major version counts as more than one behind when the report is the older.
 */
export function minorsBehind(reportVersion, appVersion) {
  const report = parseVersion(reportVersion);
  const app = parseVersion(appVersion);
  if (report.major < app.major) return Number.POSITIVE_INFINITY;
  if (report.major > app.major) return 0;
  return Math.max(0, app.minor - report.minor);
}
