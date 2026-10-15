#!/usr/bin/env node
/**
 * `pnpm a11y:audit`: the accessibility audit of #401. Drives Chromium through Playwright against a
 * seeded, running instance, runs the automated, accessibility-tree, measured and keyboard checks
 * the spec's Method names, and writes `evidence.json` (counts and findings per criterion and
 * route; no screenshots, no page text, no secrets). `report.mjs` turns that into the report.
 *
 * It changes the instance while it runs (an accent colour, the enabled languages, the
 * verification requirement for a moment, fresh accounts, one provider with two models, a group)
 * and puts the settings back; run it against a disposable instance, never production.
 */

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, parseArgs, USAGE } from './lib/args.mjs';
import { loadTools } from './lib/deps.mjs';
import { createEvidence } from './lib/evidence.mjs';
import { createGroup, ensureCatalog, userIdFor } from './lib/fixtures.mjs';
import { buildMatrix } from './lib/matrix.mjs';
import { loadRoutes } from './lib/routes.mjs';
import {
  adminCredentials,
  apiAs,
  createAccount,
  createProject,
  createThread,
  storageStateFor,
} from './lib/session.mjs';
import { auditContexts } from './run.mjs';

const log = (message) => process.stderr.write(`${message}\n`);

/** Pseudo-locales exist only in builds made with VITE_OCI_PSEUDO_LOCALES=1 (or not production). */
async function pseudoLocalesWork(browser, baseUrl) {
  const context = await browser.newContext({ baseURL: baseUrl });
  try {
    await context.addInitScript(() => localStorage.setItem('oci.pseudoLocale', 'ar-XB'));
    const page = await context.newPage();
    await page.goto('/auth/login', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.lang === 'ar-XB', undefined, {
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  } finally {
    await context.close();
  }
}

export async function main(argv, env = process.env) {
  const options = parseArgs(argv, env);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const only = new Set(options.only ?? ['pages', 'walkthroughs', 'global']);
  if (options.noWalkthroughs) only.delete('walkthroughs');
  const started = Date.now();
  const { playwright, AxeBuilder, versions } = await loadTools();
  const evidence = createEvidence();
  const coverage = {};
  const errors = [];
  const skipped = [];
  const routes = loadRoutes();

  const browser = await playwright.chromium.launch();
  const admin = await apiAs(playwright, options.baseUrl, adminCredentials(env));
  const before = await (await admin.get('/api/admin/settings')).json();
  const restore = async () => {
    // Put back what the run changed: the accent, the languages, the verification requirement.
    await admin.patch('/api/admin/settings', {
      data: {
        colorTheme: before.colorTheme,
        language: before.language ?? { enabled: ['en'], default: null },
        emailVerificationRequired: before.emailVerificationRequired,
      },
    });
  };

  try {
    // Languages: the real ones need enabling on the instance; pseudo-locales need the build.
    const languages = [];
    for (const language of options.languages) {
      if (language === 'en') languages.push(language);
      else if (language === 'en-XA' || language === 'ar-XB') {
        if (await pseudoLocalesWork(browser, options.baseUrl)) languages.push(language);
        else
          skipped.push({
            what: `language ${language}`,
            reason: 'this build has no pseudo-locales (build with VITE_OCI_PSEUDO_LOCALES=1)',
          });
      } else languages.push(language);
    }
    const realExtra = languages.filter((language) => language !== 'en' && !language.includes('-X'));
    if (realExtra.length > 0) {
      const enabled = [...new Set(['en', ...(before.language?.enabled ?? []), ...realExtra])];
      const patched = await admin.patch('/api/admin/settings', {
        data: { language: { enabled, default: null } },
      });
      if (!patched.ok()) throw new Error(`Enabling languages failed: ${patched.status()}`);
    }

    await ensureCatalog(admin);

    const roles = options.roles.filter((role) => role !== 'anonymous');
    const accounts = {};
    for (const role of roles) {
      const account = await createAccount(admin, role);
      const state = await storageStateFor(browser, options.baseUrl, account);
      const api = await apiAs(playwright, options.baseUrl, account);
      accounts[role] = { ...account, state, api, params: {} };
    }
    // Pages with a parameter need something to open.
    const adminAccount = accounts.admin;
    for (const role of roles) {
      const account = accounts[role];
      account.params.threadId = await createThread(account.api, 'Audit conversation');
      account.params.projectId = await createProject(account.api, 'Audit project');
      account.params.slug = 'a11y-audit-missing';
    }
    if (adminAccount) {
      const target = accounts.user ?? adminAccount;
      adminAccount.params.userId = await userIdFor(admin, target.email);
      const group = await createGroup(admin, adminAccount.email);
      adminAccount.params.groupId = group.id;
    }

    const matrix = {
      profile: options.matrix,
      roles: options.roles,
      themes: options.themes,
      accents: options.accents,
      views: options.views,
      languages,
    };
    const contexts = buildMatrix(matrix);
    const run = {
      themes: options.themes,
      accents: options.accents,
      concurrency: options.concurrency,
      routeFilter: options.routes ? new RegExp(options.routes) : null,
    };

    if (only.has('pages')) {
      for (const accent of options.accents) {
        const group = contexts.filter((context) => context.accent === accent);
        if (group.length === 0) continue;
        log(`accent ${accent}: ${group.length} contexts`);
        const patched = await admin.patch('/api/admin/settings', { data: { colorTheme: accent } });
        if (!patched.ok()) throw new Error(`Setting the accent failed: ${patched.status()}`);
        await auditContexts({
          browser,
          baseUrl: options.baseUrl,
          routes,
          accounts,
          contexts: group,
          run,
          AxeBuilder,
          evidence,
          coverage,
          errors,
          log,
        });
      }
      await admin.patch('/api/admin/settings', { data: { colorTheme: before.colorTheme } });
    }

    const shared = {
      playwright,
      browser,
      baseUrl: options.baseUrl,
      admin,
      accounts,
      routes,
      evidence,
      errors,
      skipped,
      log,
      languages,
      env,
    };
    if (only.has('global')) {
      const { runGlobalChecks } = await import('./global.mjs');
      await runGlobalChecks(shared);
    }
    if (only.has('walkthroughs')) {
      const { runWalkthroughs } = await import('./walkthroughs.mjs');
      await runWalkthroughs(shared);
    }

    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - started) / 1000),
      tool: { name: 'scripts/a11y-audit', ...versions, browser: `Chromium ${browser.version()}` },
      app: { baseUrlHost: new URL(options.baseUrl).host },
      matrix: {
        profile: options.matrix,
        roles: options.roles,
        themes: options.themes,
        accents: options.accents,
        views: options.views,
        languages,
        contexts: contexts.length,
        routeFilter: options.routes ?? null,
        parts: [...only],
      },
      routes: {
        listed: routes.length,
        coverage,
      },
      skipped,
      errors: errors.slice(0, 100),
      errorCount: errors.length,
      ...evidence.toJSON(),
    };
    mkdirSync(options.out, { recursive: true });
    writeFileSync(join(options.out, 'evidence.json'), `${JSON.stringify(result, null, 2)}\n`);
    log(
      `wrote ${join(options.out, 'evidence.json')} (${result.findings.length} findings, ${errors.length} errors)`,
    );
    return 0;
  } finally {
    await restore().catch((error) =>
      log(`could not restore the instance settings: ${error.message}`),
    );
    await browser.close();
    await admin.dispose();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exit(1);
    },
  );
}

export { DEFAULTS };
