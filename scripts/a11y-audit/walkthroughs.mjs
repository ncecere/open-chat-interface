/**
 * Step 2 of the Method: keyboard-only walkthroughs of the primary tasks. Every step is a
 * `page.keyboard` press (Tab, Shift+Tab, arrows, Enter, Escape, typing); the mouse and
 * `locator.click()` are never used to make progress, only to read the result. For each task the
 * evidence records whether it completed, how many tab stops it took, and what stopped it.
 *
 * Tasks that need a model run against the stand-in (lib/stand-in.mjs): the audit's instance
 * has no working provider. Sign-in with two-step verification uses a fresh account enrolled
 * through the API.
 */

import { skipLinkCheck, walkTabs } from './checks/keyboard.mjs';
import { settle } from './checks/measured.mjs';
import { VIEWS } from './lib/matrix.mjs';
import {
  apiAs,
  createAccount,
  createProject,
  createThread,
  enrolTotp,
  nextCode,
  storageStateFor,
} from './lib/session.mjs';
import {
  ARTIFACT_THREAD,
  installArtifact,
  installSlowReply,
  installToolApproval,
  TOOLS_THREAD,
} from './lib/stand-in.mjs';

const context = {
  role: 'user',
  theme: 'light',
  accent: 'neutral',
  viewport: '1280',
  language: 'en',
};

/** Runs in the page: the accessible name of what has focus, as far as a script can tell. */
const describeFocus = () => {
  const element = document.activeElement;
  if (!element || element === document.body) return null;
  const labelled = element.getAttribute('aria-labelledby');
  const name =
    element.getAttribute('aria-label') ||
    (labelled ? document.getElementById(labelled.split(' ')[0])?.textContent : '') ||
    (element.labels?.length
      ? [...element.labels].map((label) => label.textContent).join(' ')
      : '') ||
    element.textContent ||
    element.getAttribute('placeholder') ||
    element.getAttribute('title') ||
    '';
  return {
    name: name.replace(/\s+/g, ' ').trim().slice(0, 80),
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role'),
    type: element.getAttribute('type'),
    autocomplete: element.getAttribute('autocomplete'),
    inDialog: Boolean(element.closest('[role="dialog"], [role="alertdialog"]')),
  };
};

class Walk {
  constructor(page, id) {
    this.page = page;
    this.id = id;
    this.presses = 0;
    this.steps = [];
  }

  note(text) {
    this.steps.push(text);
  }

  /** Tab (or Shift+Tab) until the focused control's name matches; false if it never does. */
  async reach(pattern, { limit = 70, backwards = false, label = String(pattern) } = {}) {
    const expression = new RegExp(pattern, 'i');
    for (let i = 0; i <= limit; i += 1) {
      const focus = await this.page.evaluate(describeFocus);
      if (focus && expression.test(`${focus.name}`)) {
        this.note(
          `reached ${label}${i ? ` after ${i} Tab press${i === 1 ? '' : 'es'}` : ' (already focused)'}`,
        );
        return focus;
      }
      await this.page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
      this.presses += 1;
    }
    this.note(`could not reach ${label} with ${limit} Tab presses`);
    return null;
  }

  async focus() {
    return this.page.evaluate(describeFocus);
  }
}

/** Runs one task, recording the outcome; a task that cannot be completed is a 2.1.1 failure. */
async function task({ evidence, errors, log }, id, title, body, { page }) {
  const walk = new Walk(page, id);
  let completed = false;
  let reason = null;
  try {
    completed = Boolean(await body(walk));
    if (!completed) reason = walk.steps.at(-1) ?? 'the task did not reach its goal';
  } catch (error) {
    reason = String(error.message).split('\n')[0];
    errors.push({ route: `walkthrough:${id}`, check: 'walkthrough', message: reason });
  }
  evidence.sample(['2.1.1'], 'walkthrough', `walkthrough:${id}`);
  evidence.fact('walkthroughs', id, {
    title,
    completed,
    tabPresses: walk.presses,
    steps: walk.steps.slice(0, 30),
    reason,
  });
  if (!completed) {
    evidence.finding({
      criteria: ['2.1.1'],
      check: 'walkthrough',
      rule: 'task-not-completable-by-keyboard',
      severity: 'serious',
      route: `walkthrough:${id}`,
      context,
      message: `"${title}" was not completed with the keyboard alone: ${reason}`,
      targets: [id],
    });
  }
  log(`  ${completed ? 'ok  ' : 'FAIL'} ${id}${reason ? `: ${reason}` : ''}`);
  return completed;
}

async function open(browser, baseUrl, state, { width = 1280, height = 800 } = {}) {
  const browserContext = await browser.newContext({
    baseURL: baseUrl,
    storageState: state,
    viewport: { width, height },
    locale: 'en-US',
  });
  await browserContext.addInitScript(() => {
    try {
      localStorage.setItem('oci.theme', 'light');
    } catch {
      // The page keeps its default theme.
    }
  });
  const page = await browserContext.newPage();
  return { browserContext, page };
}

async function load(page, path) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page
    .locator('main, [role="main"]')
    .first()
    .waitFor({ state: 'attached', timeout: 8_000 })
    .catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
  await settle(page);
}

/** Whether a locator becomes visible within `timeout` ms (`isVisible` does not wait). */
const appears = (locator, timeout = 8_000) =>
  locator.waitFor({ state: 'visible', timeout }).then(
    () => true,
    () => false,
  );

/**
 * What has focus once a dialog has closed. Focus is handed back a moment after the dialog leaves
 * the page, so it is polled for rather than read at once (which reported a false loss).
 */
async function focusAfterClose(page, walk) {
  for (let waited = 0; waited < 1_500; waited += 100) {
    const focus = await walk.focus();
    if (focus) return focus;
    await page.waitForTimeout(100);
  }
  return null;
}

/** Records every change to live-region text, so "was this announced" is observed, not assumed. */
async function watchLiveRegions(page) {
  await page.evaluate(() => {
    window.__a11yLive = { changes: 0, texts: [] };
    const selector =
      '[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]';
    const record = (node) => {
      const region = (node.nodeType === 1 ? node : node.parentElement)?.closest(selector);
      if (!region) return;
      const text = (region.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      // A region emptied or toggled with no words is not an announcement.
      if (!text) return;
      window.__a11yLive.changes += 1;
      if (!window.__a11yLive.texts.includes(text) && window.__a11yLive.texts.length < 8)
        window.__a11yLive.texts.push(text);
    };
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        record(mutation.target);
        for (const added of mutation.addedNodes) record(added);
      }
    }).observe(document.body, { childList: true, characterData: true, subtree: true });
  });
}

const liveChanges = (page) => page.evaluate(() => window.__a11yLive ?? { changes: 0, texts: [] });

export async function runWalkthroughs({
  playwright,
  browser,
  baseUrl,
  admin,
  evidence,
  errors,
  log,
  accounts,
}) {
  const kit = { evidence, errors, log };
  log('keyboard walkthroughs');

  const make = async (role) => {
    const account = await createAccount(admin, role, 'Walkthrough');
    const state = await storageStateFor(browser, baseUrl, account);
    const api = await apiAs(playwright, baseUrl, account);
    return { ...account, state, api };
  };
  const person = await make('user');
  const colleague = await make('user');
  const manager = accounts.admin ?? (await make('admin'));

  // --- Sign in, password only ------------------------------------------------------------
  {
    const fresh = await createAccount(admin, 'user', 'Walkthrough');
    const { browserContext, page } = await open(browser, baseUrl);
    await task(
      kit,
      'sign-in',
      'Sign in with an email address and password',
      async (walk) => {
        await load(page, '/auth/login');
        const stops = await walkTabs(page, {
          evidence,
          route: '/auth/login',
          context,
          label: 'sign-in',
          limit: 20,
        });
        walk.note(`${stops.stops.length} tab stops on the sign-in page`);
        await page.evaluate(() => document.activeElement?.blur());
        if (!(await walk.reach('^email', { label: 'the email field' }))) return false;
        await page.keyboard.type(fresh.email, { delay: 2 });
        await page.keyboard.press('Tab');
        if (!/password/i.test((await walk.focus())?.name ?? '')) return false;
        await page.keyboard.type(fresh.password, { delay: 2 });
        await page.keyboard.press('Enter');
        await page
          .waitForURL((url) => url.pathname === '/', { timeout: 10_000 })
          .catch(() => undefined);
        // A new account meets the introduction first; skipping it is the same choice a person has.
        const skip = page.getByRole('button', { name: 'Skip for now' });
        await skip.waitFor({ state: 'visible', timeout: 4_000 }).catch(() => undefined);
        if (await skip.isVisible().catch(() => false)) {
          if (!(await walk.reach('skip for now', { label: 'Skip for now' }))) return false;
          await page.keyboard.press('Enter');
        }
        return appears(page.getByRole('textbox', { name: 'Message input' }));
      },
      { page },
    );
    await browserContext.close();
  }

  // --- Sign in with two-step verification ------------------------------------------------
  {
    const enrolled = await createAccount(admin, 'user', 'Walkthrough');
    const api = await apiAs(playwright, baseUrl, enrolled);
    const { secret } = await enrolTotp(api, enrolled);
    await api.post('/api/me/onboarding/skip');
    const used = new Set();
    // The enrolment's own confirming code is spent for two minutes.
    used.add((await import('./lib/totp.mjs')).totp(secret));
    const { browserContext, page } = await open(browser, baseUrl);
    await task(
      kit,
      'sign-in-two-step',
      'Sign in with a password and an authentication code',
      async (walk) => {
        await load(page, '/auth/login');
        if (!(await walk.reach('^email', { label: 'the email field' }))) return false;
        await page.keyboard.type(enrolled.email, { delay: 2 });
        await page.keyboard.press('Tab');
        await page.keyboard.type(enrolled.password, { delay: 2 });
        await page.keyboard.press('Enter');
        await page.waitForURL(/\/auth\/two-factor/, { timeout: 10_000 }).catch(() => undefined);
        if (!page.url().includes('/auth/two-factor')) {
          walk.note('the second step page did not open');
          return false;
        }
        await load(page, page.url().replace(baseUrl, ''));
        const route = '/auth/two-factor';
        await walkTabs(page, { evidence, route, context, label: 'sign-in-two-step', limit: 20 });
        await page.evaluate(() => document.activeElement?.blur());
        const field = await walk.reach('code', { label: 'the code field' });
        if (!field) return false;
        // 3.3.8: the code field names its purpose, takes paste, and the step asks for nothing it
        // already has (3.3.7) and sets no puzzle.
        evidence.sample(['3.3.8', '1.3.5'], 'walkthrough', route);
        if (field.autocomplete !== 'one-time-code') {
          evidence.finding({
            criteria: ['3.3.8', '1.3.5'],
            check: 'walkthrough',
            rule: 'code-field-autocomplete',
            severity: 'moderate',
            route,
            context,
            message: `The code field has autocomplete "${field.autocomplete ?? ''}", expected one-time-code`,
            targets: ['input'],
          });
        }
        const second = await page.evaluate(() => {
          const data = new DataTransfer();
          data.setData('text/plain', '123456');
          const field = document.activeElement;
          const event = new ClipboardEvent('paste', {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          });
          field?.dispatchEvent(event);
          const labels = [...document.querySelectorAll('input:not([type="hidden"])')].map((input) =>
            `${input.type} ${input.getAttribute('autocomplete') ?? ''} ${input.labels?.[0]?.textContent ?? ''}`.toLowerCase(),
          );
          return {
            pasteRefused: event.defaultPrevented,
            asksAgainForEmailOrPassword: labels.some((label) =>
              /email|password|username/.test(label),
            ),
            puzzle: Boolean(
              document.querySelector(
                'iframe[src*="captcha" i], [class*="captcha" i], img[alt*="captcha" i]',
              ),
            ),
          };
        });
        evidence.sample(['3.3.7'], 'walkthrough', route);
        evidence.fact('authentication', 'second-step', second);
        if (second.pasteRefused) {
          evidence.finding({
            criteria: ['3.3.8'],
            check: 'walkthrough',
            rule: 'paste-blocked',
            severity: 'serious',
            route,
            context,
            message: 'Pasting a code is refused',
            targets: ['input'],
          });
        }
        if (second.asksAgainForEmailOrPassword) {
          evidence.finding({
            criteria: ['3.3.7'],
            check: 'walkthrough',
            rule: 'redundant-entry',
            severity: 'serious',
            route,
            context,
            message: 'The second step asks again for the email address or password',
            targets: ['input'],
          });
        }
        if (second.puzzle) {
          evidence.finding({
            criteria: ['3.3.8'],
            check: 'walkthrough',
            rule: 'cognitive-test',
            severity: 'serious',
            route,
            context,
            message: 'The second step carries a puzzle or image test',
            targets: ['iframe'],
          });
        }
        await page.keyboard.type(nextCode(secret, used), { delay: 2 });
        await page.keyboard.press('Enter');
        await page
          .waitForURL((url) => url.pathname === '/', { timeout: 10_000 })
          .catch(() => undefined);
        return appears(page.getByRole('textbox', { name: 'Message input' }));
      },
      { page },
    );
    await browserContext.close();
    await api.dispose();
  }

  // --- Chat: start, send (to the end of the reply) -----------------------------------------
  {
    const { browserContext, page } = await open(browser, baseUrl, person.state);
    await installSlowReply(page, { chunkMs: 150, chunks: 12 });
    await task(
      kit,
      'start-chat-and-send',
      'Start a conversation and send a message',
      async (walk) => {
        await load(page, '/');
        await walkTabs(page, { evidence, route: '/', context, label: 'start-chat', limit: 40 });
        await skipLinkCheck(page, { evidence, route: '/', context });
        await page.evaluate(() => {
          document.activeElement?.blur();
          document.querySelector('[role="textbox"], textarea')?.blur();
        });
        if (!(await walk.reach('message input', { label: 'the message box' }))) return false;
        await watchLiveRegions(page);
        await page.keyboard.type('Please write an answer', { delay: 2 });
        await page.keyboard.press('Enter');
        await page.waitForURL(/\/chat\//, { timeout: 10_000 }).catch(() => undefined);
        walk.note(`opened ${new URL(page.url()).pathname.replace(/[0-9a-f-]{36}/, ':id')}`);
        const shown = await page
          .getByText('word11')
          .first()
          .waitFor({ state: 'visible', timeout: 15_000 })
          .then(
            () => true,
            () => false,
          );
        await page.waitForTimeout(800);
        // 4.1.3: was a person who cannot see the page told that a reply started and finished?
        const live = await liveChanges(page);
        evidence.sample(['4.1.3'], 'walkthrough', '/chat/$threadId');
        evidence.fact('statusMessages', 'streaming-reply', {
          replyShown: shown,
          liveRegionAnnouncements: live.changes,
          texts: live.texts,
        });
        walk.note(
          `${live.changes} live-region announcement(s) from the start of the reply to its end`,
        );
        if (shown && live.changes === 0) {
          evidence.finding({
            criteria: ['4.1.3'],
            check: 'walkthrough',
            rule: 'reply-not-announced',
            severity: 'serious',
            route: '/chat/$threadId',
            context,
            message:
              'No live region announced anything between the start and the end of a streamed reply (the "waiting" indicator is a status element with an aria-label and no text), so a screen reader is not told a reply is coming or has arrived',
            targets: ['main'],
          });
        }
        return shown;
      },
      { page },
    );
    await browserContext.close();
  }

  // --- Chat: stop a reply that is still being written ---------------------------------------
  {
    const { browserContext, page } = await open(browser, baseUrl, person.state);
    await installSlowReply(page, { chunkMs: 300, chunks: 60 });
    await task(
      kit,
      'stop',
      'Stop a reply while it is being written',
      async (walk) => {
        await load(page, '/');
        await page.evaluate(() => document.querySelector('[role="textbox"], textarea')?.blur());
        if (!(await walk.reach('message input', { label: 'the message box' }))) return false;
        await page.keyboard.type('Please write a long answer', { delay: 2 });
        await page.keyboard.press('Enter');
        await page.waitForURL(/\/chat\//, { timeout: 10_000 }).catch(() => undefined);
        await page
          .getByText('word2')
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 })
          .catch(() => undefined);
        const stream = await page.evaluate(() => window.__a11yStream ?? null);
        if (!stream || stream.finished) {
          walk.note('the reply was not streaming');
          return false;
        }
        // Stop is reached by Tab from the message box.
        await page.evaluate(() => document.querySelector('[role="textbox"], textarea')?.focus());
        if (!(await walk.reach('^stop', { limit: 20, label: 'Stop' }))) return false;
        await page.keyboard.press('Enter');
        await page
          .waitForFunction(() => window.__a11yStream?.aborted === true, undefined, {
            timeout: 8_000,
          })
          .catch(() => undefined);
        const after = await page.evaluate(() => window.__a11yStream ?? {});
        walk.note(after.aborted ? 'the reply stopped' : 'the reply kept running');
        return after.aborted === true;
      },
      { page },
    );
    await browserContext.close();
  }

  // --- A reply that fails: is it announced? (the provider is a closed port) ----------------
  {
    const { browserContext, page } = await open(browser, baseUrl, person.state);
    await task(
      kit,
      'send-error',
      'Send a message when the model cannot answer, and learn of it',
      async (walk) => {
        await load(page, '/');
        await page.evaluate(() => document.querySelector('[role="textbox"], textarea')?.blur());
        if (!(await walk.reach('message input', { label: 'the message box' }))) return false;
        await watchLiveRegions(page);
        await page.keyboard.type('Hello', { delay: 2 });
        await page.keyboard.press('Enter');
        await page.waitForURL(/\/chat\//, { timeout: 10_000 }).catch(() => undefined);
        // The failure is shown when the provider's connection attempts are given up (about ten
        // seconds against a closed port): wait for it rather than for a fixed time.
        const alert = page.getByRole('alert').filter({ hasText: /\S/ });
        const shown = await appears(alert.first(), 40_000);
        const live = await liveChanges(page);
        evidence.sample(['4.1.3', '3.3.1'], 'walkthrough', '/chat/$threadId');
        evidence.fact('statusMessages', 'reply-failed', {
          errorShown: shown,
          asAlert: shown,
          liveRegionAnnouncements: live.changes,
          texts: live.texts,
        });
        walk.note(
          shown
            ? `the failure appeared as an alert: "${live.texts[0] ?? ''}"`
            : 'no failure message appeared within 40 s',
        );
        if (!shown) {
          evidence.finding({
            criteria: ['4.1.3'],
            check: 'walkthrough',
            rule: 'error-not-announced',
            severity: 'serious',
            route: '/chat/$threadId',
            context,
            message: 'A failed reply showed no alert or status message within 40 s',
            targets: ['main'],
          });
        }
        return shown;
      },
      { page },
    );
    await browserContext.close();
  }

  // --- Approve a tool --------------------------------------------------------------------
  {
    const { browserContext, page } = await open(browser, baseUrl, person.state);
    await installToolApproval(page);
    await task(
      kit,
      'approve-tool',
      'Approve a tool call',
      async (walk) => {
        await load(page, `/chat/${TOOLS_THREAD}`);
        const card = page.getByRole('region', { name: /^Allow/ });
        const waiting = card.getByRole('status');
        const status = {
          card: await appears(card, 6_000),
          status:
            (
              await waiting
                .first()
                .textContent({ timeout: 2_000 })
                .catch(() => null)
            )?.trim() ?? null,
        };
        evidence.sample(['4.1.3'], 'walkthrough', '/chat/$threadId');
        evidence.fact('statusMessages', 'tool-waiting-for-approval', status);
        if (!status.status) {
          evidence.finding({
            criteria: ['4.1.3'],
            check: 'walkthrough',
            rule: 'tool-progress-not-in-status',
            severity: 'moderate',
            route: '/chat/$threadId',
            context,
            message: 'The approval card has no status text announcing that a tool is waiting',
            targets: ['section'],
          });
        }
        await walkTabs(page, {
          evidence,
          route: '/chat/$threadId',
          context,
          label: 'approve-tool',
          limit: 40,
        });
        await page.evaluate(() => document.activeElement?.blur());
        if (!(await walk.reach('^approve', { label: 'Approve' }))) return false;
        await page.keyboard.press('Enter');
        return page
          .getByText('Sent the note to Ada.')
          .waitFor({ state: 'visible', timeout: 8_000 })
          .then(
            () => true,
            () => false,
          );
      },
      { page },
    );
    await browserContext.close();
  }

  // --- Open an artifact, and resize its panel without a drag (2.5.7) ---------------------
  {
    const { browserContext, page } = await open(browser, baseUrl, person.state);
    await installArtifact(page);
    await task(
      kit,
      'open-artifact',
      'Open an artifact and resize its panel',
      async (walk) => {
        await load(page, `/chat/${ARTIFACT_THREAD}`);
        if (!(await walk.reach('open artifact', { label: 'Open artifact' }))) return false;
        await page.keyboard.press('Enter');
        const panel = page.getByRole('complementary', { name: 'Plan' });
        if (!(await appears(panel, 6_000))) {
          walk.note('the artifact panel did not open');
          return false;
        }
        const focusIn = await page.evaluate(() =>
          Boolean(
            document.activeElement?.closest('aside, [role="complementary"], [role="dialog"]'),
          ),
        );
        walk.note(focusIn ? 'focus moved into the panel' : 'focus stayed outside the panel');
        // 2.5.7: a drag handle needs a way to do the same without dragging.
        evidence.sample(['2.5.7'], 'walkthrough', '/chat/$threadId');
        // The handle is the panel's left edge, before its content: Shift+Tab from inside it.
        const handle =
          (await walk.reach('resize artifact panel', {
            limit: 12,
            backwards: true,
            label: 'the panel resize handle (Shift+Tab)',
          })) ??
          (await walk.reach('resize artifact panel', {
            limit: 40,
            label: 'the panel resize handle (Tab)',
          }));
        if (!handle) {
          evidence.finding({
            criteria: ['2.5.7'],
            check: 'walkthrough',
            rule: 'resize-has-no-keyboard-alternative',
            severity: 'serious',
            route: '/chat/$threadId',
            context,
            message: 'The artifact panel resize handle cannot be reached by keyboard',
            targets: ['[role=separator]'],
          });
          evidence.fact('dragging', 'artifact-panel-resize', { nonDragAlternative: false });
          return true;
        }
        const width = () => panel.boundingBox().then((box) => Math.round(box?.width ?? 0));
        const before = await width();
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(250);
        const after = await width();
        const works = after !== before;
        evidence.fact('dragging', 'artifact-panel-resize', {
          nonDragAlternative: works,
          how: 'the handle is a keyboard-focusable separator that ArrowLeft and ArrowRight move by 32 px',
          widthBefore: before,
          widthAfter: after,
        });
        if (!works) {
          evidence.finding({
            criteria: ['2.5.7'],
            check: 'walkthrough',
            rule: 'resize-keyboard-does-nothing',
            severity: 'serious',
            route: '/chat/$threadId',
            context,
            message: 'ArrowLeft on the resize handle did not change the panel width',
            targets: ['[role=separator]'],
          });
        }
        return true;
      },
      { page },
    );
    await browserContext.close();
  }

  // --- Search, rename -------------------------------------------------------------------
  {
    const title = 'Audit search target';
    await createThread(person.api, title);
    const { browserContext, page } = await open(browser, baseUrl, person.state);
    await task(
      kit,
      'search',
      'Search conversations and open a result',
      async (walk) => {
        await load(page, '/');
        await page.evaluate(() => document.activeElement?.blur());
        if (!(await walk.reach('search your conversations', { label: 'the search box' })))
          return false;
        await page.keyboard.type('search target', { delay: 2 });
        await page.waitForTimeout(1_500);
        // Tab out of the box into the results and open the first one.
        await page.keyboard.press('Tab');
        walk.note(`focus then on: ${(await walk.focus())?.name ?? 'nothing'}`);
        for (let i = 0; i < 6; i += 1) {
          const focus = await walk.focus();
          if (focus && /search target/i.test(focus.name) && focus.tag === 'a') break;
          await page.keyboard.press('Tab');
          walk.presses += 1;
        }
        const focus = await walk.focus();
        if (!(focus && /search target/i.test(focus.name))) {
          walk.note('no search result could be reached by keyboard');
          return false;
        }
        await page.keyboard.press('Enter');
        await page.waitForURL(/\/chat\//, { timeout: 8_000 }).catch(() => undefined);
        return /\/chat\//.test(page.url());
      },
      { page },
    );

    await task(
      kit,
      'rename',
      'Rename a conversation',
      async (walk) => {
        await load(page, '/');
        await page.evaluate(() => document.activeElement?.blur());
        if (
          !(await walk.reach(`rename conversation: ${title}`, {
            limit: 120,
            label: 'the Rename button',
          }))
        )
          return false;
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.type('Renamed by keyboard', { delay: 2 });
        await page.keyboard.press('Enter');
        return page
          .getByRole('link', { name: 'Renamed by keyboard' })
          .first()
          .waitFor({ state: 'visible', timeout: 6_000 })
          .then(
            () => true,
            () => false,
          );
      },
      { page },
    );
    await browserContext.close();
  }

  // --- Project: share, add a file -------------------------------------------------------
  {
    const projectId = await createProject(person.api, 'Walkthrough project');
    const { browserContext, page } = await open(browser, baseUrl, person.state);
    await task(
      kit,
      'share',
      'Share a project with a person',
      async (walk) => {
        await load(page, `/projects/${projectId}`);
        await page.evaluate(() => document.activeElement?.blur());
        if (!(await walk.reach('^share$', { label: 'Share' }))) return false;
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog');
        if (!(await appears(dialog, 5_000))) return false;
        const inside = (await walk.focus())?.inDialog ?? false;
        walk.note(inside ? 'focus moved into the dialog' : 'focus did not move into the dialog');
        evidence.sample(['2.4.3'], 'walkthrough', '/projects/$projectId');
        if (!(await walk.reach('email', { label: 'the email field', limit: 12 }))) return false;
        await page.keyboard.type(colleague.email, { delay: 2 });
        if (!(await walk.reach('share project', { label: 'Share project', limit: 12 })))
          return false;
        await page.keyboard.press('Enter');
        const shared = await dialog
          .getByRole('list', { name: 'Who has access' })
          .waitFor({ state: 'visible', timeout: 6_000 })
          .then(
            () => true,
            () => false,
          );
        await page.keyboard.press('Escape');
        const closed = await dialog.isHidden({ timeout: 3_000 }).catch(() => false);
        const returned = (await focusAfterClose(page, walk))?.name ?? '';
        walk.note(
          closed
            ? `Escape closed the dialog; focus returned to ${returned ? `"${returned}"` : 'nothing (the page)'}`
            : 'Escape did not close the dialog',
        );
        evidence.fact('dialogs', 'share-project-escape', {
          closed,
          focusReturnedTo: returned || null,
        });
        if (closed && returned === '') {
          evidence.finding({
            criteria: ['2.4.3'],
            check: 'walkthrough',
            rule: 'focus-lost-after-dialog',
            severity: 'moderate',
            route: '/projects/$projectId',
            context,
            message:
              'After Escape closed the Share dialog, focus was on nothing: the person starts again from the top of the page',
            targets: ['dialog'],
          });
        }
        return shared && closed;
      },
      { page },
    );

    await task(
      kit,
      'add-project-file',
      'Add a file to a project',
      async (walk) => {
        await load(page, `/projects/${projectId}`);
        await page.evaluate(() => document.activeElement?.blur());
        // The tabs are one tab stop; the arrow keys move between them.
        if (!(await walk.reach('^conversations$', { label: 'the project tabs' }))) return false;
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        if (!/^files$/i.test((await walk.focus())?.name ?? '')) return false;
        await page.waitForTimeout(500);
        if (
          !(await walk.reach('add file|upload|attach|choose', {
            limit: 30,
            label: 'the add-files button',
          }))
        )
          return false;
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 5_000 }),
          page.keyboard.press('Enter'),
        ]);
        await chooser.setFiles({
          name: 'audit-note.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('A short note for the audit.'),
        });
        return page
          .getByText('audit-note.txt')
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 })
          .then(
            () => true,
            () => false,
          );
      },
      { page },
    );
    await browserContext.close();
  }

  // --- Settings --------------------------------------------------------------------------
  {
    const { browserContext, page } = await open(browser, baseUrl, person.state);
    await task(
      kit,
      'change-settings',
      'Change a setting and save it',
      async (walk) => {
        await load(page, '/settings/customization');
        await walkTabs(page, {
          evidence,
          route: '/settings/customization',
          context,
          label: 'change-settings',
          limit: 50,
        });
        await page.evaluate(() => document.activeElement?.blur());
        if (!(await walk.reach('what should the assistant call you', { label: 'the name field' })))
          return false;
        await page.keyboard.type('Audit Person', { delay: 2 });
        if (!(await walk.reach('save preferences', { limit: 30, label: 'Save Preferences' })))
          return false;
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1_200);
        // Appearance is a radio group: arrow keys move within it.
        await page.evaluate(() => document.activeElement?.blur());
        if (
          !(await walk.reach('^(light|dark|system)$', {
            limit: 60,
            label: 'the Appearance radio group',
          }))
        )
          return false;
        const before = await page.evaluate(() =>
          document.documentElement.classList.contains('dark'),
        );
        await page.keyboard.press(before ? 'ArrowUp' : 'ArrowDown');
        await page.waitForTimeout(400);
        const after = await page.evaluate(() =>
          document.documentElement.classList.contains('dark'),
        );
        walk.note(
          after !== before ? 'arrow keys changed the theme' : 'arrow keys did not change the theme',
        );
        await page.reload({ waitUntil: 'domcontentloaded' });
        await settle(page);
        const saved = await page
          .getByRole('textbox', { name: 'What should the assistant call you?' })
          .inputValue()
          .catch(() => '');
        walk.note(
          saved === 'Audit Person' ? 'the saved name survived a reload' : 'the name was not saved',
        );
        return saved === 'Audit Person' && after !== before;
      },
      { page },
    );
    await browserContext.close();
  }

  // --- An administrator's task: create a group, and the dialog's focus behaviour ----------
  {
    const { browserContext, page } = await open(browser, baseUrl, manager.state);
    await task(
      kit,
      'admin-create-group',
      'Create a group in the administration console',
      async (walk) => {
        await load(page, '/admin/groups');
        await walkTabs(page, {
          evidence,
          route: '/admin/groups',
          context: { ...context, role: 'admin' },
          label: 'admin-create-group',
          limit: 40,
        });
        await page.evaluate(() => document.activeElement?.blur());
        if (!(await walk.reach('^new group', { label: 'New group' }))) return false;
        const trigger = await walk.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog');
        if (!(await appears(dialog, 5_000))) return false;
        evidence.sample(['2.4.3', '2.1.2'], 'walkthrough', '/admin/groups');
        const focusIn = (await walk.focus())?.inDialog ?? false;
        walk.note(focusIn ? 'focus moved into the dialog' : 'focus did not move into the dialog');
        if (!focusIn) {
          evidence.finding({
            criteria: ['2.4.3'],
            check: 'walkthrough',
            rule: 'dialog-focus-not-moved',
            severity: 'serious',
            route: '/admin/groups',
            context,
            message: 'Opening the New group dialog did not move focus into it',
            targets: ['dialog'],
          });
        }
        // Tab around inside: the dialog keeps focus (modal), and Escape is the way out.
        let escaped = 0;
        for (let i = 0; i < 12; i += 1) {
          await page.keyboard.press('Tab');
          if (!(await walk.focus())?.inDialog) escaped += 1;
        }
        walk.note(
          escaped === 0
            ? 'Tab stayed inside the open dialog'
            : `Tab left the open dialog ${escaped} times`,
        );
        if (escaped > 0) {
          evidence.finding({
            criteria: ['2.4.3'],
            check: 'walkthrough',
            rule: 'modal-focus-escapes',
            severity: 'moderate',
            route: '/admin/groups',
            context,
            message: 'Focus left a modal dialog while it was open',
            targets: ['dialog'],
          });
        }
        // Escape cancels, and focus goes back to the button that opened the dialog.
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden', timeout: 4_000 }).catch(() => undefined);
        const afterEscape = await focusAfterClose(page, walk);
        const restored = Boolean(afterEscape && trigger && afterEscape.name === trigger.name);
        walk.note(
          restored
            ? 'Escape closed the dialog and focus returned to New group'
            : `after Escape focus was on ${afterEscape?.name ? `"${afterEscape.name}"` : 'nothing (the page)'}`,
        );
        evidence.fact('dialogs', 'new-group-escape', { restored });
        if (!restored) {
          evidence.finding({
            criteria: ['2.4.3'],
            check: 'walkthrough',
            rule: 'focus-not-restored-after-dialog',
            severity: 'moderate',
            route: '/admin/groups',
            context,
            message:
              'After Escape closed the New group dialog, focus did not return to the button that opened it',
            targets: ['dialog'],
          });
          await page.evaluate(() => document.activeElement?.blur());
          if (!(await walk.reach('^new group', { label: 'New group again' }))) return false;
        }
        await page.keyboard.press('Enter');
        if (!(await appears(dialog, 5_000))) return false;
        const name = `Keyboard group ${Date.now().toString(36)}`;
        await page.evaluate(() =>
          document.querySelector('[role="dialog"] input, [role="dialog"] textarea')?.focus(),
        );
        if (!(await walk.reach('name', { limit: 12, label: 'the group name field' }))) return false;
        await page.keyboard.type(name, { delay: 2 });
        if (!(await walk.reach('^(create|save|add)', { limit: 14, label: 'the create button' })))
          return false;
        await page.keyboard.press('Enter');
        await dialog.waitFor({ state: 'hidden', timeout: 6_000 }).catch(() => undefined);
        const listed = await appears(page.getByText(name).first(), 6_000);
        const returned = await walk.focus();
        walk.note(
          returned && trigger && returned.name === trigger.name
            ? 'focus returned to New group'
            : `focus after the dialog: ${returned?.name ?? 'the page'}`,
        );
        return listed;
      },
      { page },
    );
    await browserContext.close();
  }

  // --- Character-key shortcuts (2.1.4) ---------------------------------------------------
  {
    const { browserContext, page } = await open(browser, baseUrl, person.state);
    await load(page, '/');
    const keys = [...'abcdefghijklmnopqrstuvwxyz0123456789/?.,;[]-='];
    const changed = [];
    evidence.sample(['2.1.4'], 'keyboard', '/');
    for (const key of keys) {
      await page.evaluate(() => {
        document.activeElement?.blur?.();
        document.body.focus();
      });
      const before = await page.evaluate(
        () =>
          `${location.pathname}|${document.querySelectorAll('[role="dialog"]').length}|${document.activeElement?.tagName}|${document.activeElement?.getAttribute('aria-label') ?? ''}`,
      );
      await page.keyboard.press(key);
      await page.waitForTimeout(40);
      const after = await page.evaluate(
        () =>
          `${location.pathname}|${document.querySelectorAll('[role="dialog"]').length}|${document.activeElement?.tagName}|${document.activeElement?.getAttribute('aria-label') ?? ''}`,
      );
      if (before !== after) changed.push(key);
      if (!(await page.evaluate(() => location.pathname === '/'))) await load(page, '/');
    }
    evidence.fact('shortcuts', 'single-character-keys-with-nothing-focused', {
      tried: keys.length,
      changedSomething: changed,
    });
    for (const key of changed) {
      evidence.finding({
        criteria: ['2.1.4'],
        check: 'keyboard',
        rule: 'character-key-shortcut',
        severity: 'review',
        route: '/',
        context,
        message: `Pressing "${key}" alone, with nothing focused, changes the page: check it can be turned off or remapped`,
        targets: ['body'],
      });
    }
    await browserContext.close();
  }

  // --- Consistent help (3.2.6): where a help or contact mechanism sits on each page -------
  {
    const { browserContext, page } = await open(browser, baseUrl, person.state);
    const where = {};
    for (const path of [
      '/',
      '/projects',
      '/settings',
      '/settings/customization',
      '/settings/history',
    ]) {
      await load(page, path);
      where[path] = await page.evaluate(() => {
        const found = [];
        for (const element of document.querySelectorAll(
          'a[href], button, [role="button"], [role="link"]',
        )) {
          const label = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim();
          if (
            !/^(help|contact|support|get help|send feedback|feedback|documentation|docs)\b/i.test(
              label,
            )
          )
            continue;
          const landmark = element.closest(
            'aside, nav, header, main, footer, [role="complementary"], [role="banner"], [role="main"]',
          );
          const box = element.getBoundingClientRect();
          found.push({
            label: label.slice(0, 30),
            landmark: landmark?.tagName.toLowerCase() ?? 'body',
            side: box.left + box.width / 2 < innerWidth / 2 ? 'start' : 'end',
            vertical:
              box.top + box.height / 2 < innerHeight / 3
                ? 'top'
                : box.top + box.height / 2 > (innerHeight * 2) / 3
                  ? 'bottom'
                  : 'middle',
          });
        }
        return found;
      });
    }
    evidence.sample(['3.2.6'], 'walkthrough', 'help');
    evidence.fact('consistentHelp', 'help-mechanisms-by-page', where);
    const withHelp = Object.entries(where).filter(([, entries]) => entries.length > 0);
    const places = new Set(
      withHelp.flatMap(([, entries]) =>
        entries.map((entry) => `${entry.landmark}/${entry.side}/${entry.vertical}`),
      ),
    );
    if (withHelp.length > 0 && (withHelp.length < Object.keys(where).length || places.size > 1)) {
      evidence.finding({
        criteria: ['3.2.6'],
        check: 'walkthrough',
        rule: 'help-not-in-a-consistent-place',
        severity: 'review',
        route: 'help',
        context,
        message: `A help or contact mechanism appears on ${withHelp.length} of ${Object.keys(where).length} pages and in ${places.size} different place(s): ${[...places].join(', ')}`,
        targets: ['help'],
      });
    }
    await browserContext.close();
  }

  await person.api.dispose();
  await colleague.api.dispose();
  void VIEWS;
}
