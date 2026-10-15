/**
 * A Redis URL pointing at one numbered database of the same server.
 *
 * The test files run in parallel against one Redis, and a few of them keep state in keys that others
 * also wipe (the second-step replay claims are `oci:mfa-code:*`, and each of these files clears all of
 * them). A wipe by one file between another file's first use of a code and its replay check removed
 * the claim and made the second attempt answer `INVALID_BACKUP_CODE` instead of `CODE_ALREADY_USED`,
 * which showed up as a failure in some CI runs and never locally. A file that clears keys by pattern
 * takes a database of its own, so it can only ever clear its own. Databases in use:
 *   11 mfa-signin.live, 12 mfa-requirement.live, 13 mfa-code-replay.integration.
 */
export function redisUrlForDatabase(base: string, database: number): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}
