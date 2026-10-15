import { mkdirSync } from 'node:fs';
import { type Browser, expect, type Page } from '@playwright/test';
import { reachApp } from './fixtures/introduction';

/**
 * Shared by rtl.spec.ts (the forced right-to-left pseudo-locale `ar-XB`) and
 * language.spec.ts (real Arabic): the pages that are swept, the measurement of
 * horizontal overflow, the reading-order check and the screenshots.
 *
 * Overflow in right-to-left has a trap: content pushed past the RIGHT edge is
 * not scrollable there, so `scrollWidth` does not see it (it only sees the
 * left). `overflowing()` therefore also lists elements whose box leaves the
 * viewport on either side.
 */

export const WIDTHS = [320, 768, 1280] as const;
/** Screenshots are looked at, never committed. */
export const SHOTS = process.env.RTL_SHOTS_DIR ?? '/tmp/v014/rtl-shots';

export interface Overflow {
  scroll: number;
  outside: string[];
}

/** How far the page can be panned sideways, and the visible elements that stick out of the viewport. */
export async function overflowing(page: Page): Promise<Overflow> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const outside: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.left >= -1 && rect.right <= width + 1) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0')
        continue;
      // Clipped by an ancestor (a scroll area, a truncated line) or inert (a closed drawer).
      let clipped = false;
      for (let node: HTMLElement | null = element.parentElement; node; node = node.parentElement) {
        const parent = getComputedStyle(node);
        if (node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true') {
          clipped = true;
          break;
        }
        if (parent.overflowX !== 'visible' && node.getBoundingClientRect().width <= width + 1) {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;
      const label = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}.${String(
        element.getAttribute('class') ?? '',
      )
        .split(/\s+/)
        .slice(0, 4)
        .join('.')}`;
      outside.push(`${label} [${Math.round(rect.left)}..${Math.round(rect.right)}]`);
    }
    return {
      scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      outside: outside.slice(0, 8),
    };
  });
}

export async function expectNoOverflow(page: Page, where: string) {
  // Let a late layout (fonts, the lazily loaded renderer) settle.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  const overflow = await overflowing(page);
  expect(overflow.scroll, `${where}: page pans sideways`).toBeLessThanOrEqual(0);
  expect(overflow.outside, `${where}: elements outside the viewport`).toEqual([]);
}

export async function shot(page: Page, name: string, width: number) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${width}.png`, fullPage: false });
}

/** Forces a pseudo-locale on this device before any page script runs (see lib/i18n/state.ts). */
export async function usePseudoLocale(page: Page, tag: 'ar-XB' | 'en-XA') {
  await page.addInitScript((value) => window.localStorage.setItem('oci.pseudoLocale', value), tag);
}

export async function signInAs(page: Page, email: string, password: string) {
  await page.goto('/auth/login');
  // By type, not by label: the label is in the language being tested.
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await reachApp(page, page.locator('textarea'));
}

export function adminCredentials() {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');
  return { email, password };
}

export async function signedInState(browser: Browser, email: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInAs(page, email, password);
  const state = await context.storageState();
  await context.close();
  return state;
}

// The fixtures ---------------------------------------------------------------

const created = '2026-10-05T12:00:00.000Z';

/** Arabic and English in one conversation: mixed sentences, a list, a quote, a table and code. */
export const MIXED_QUESTION = 'اكتب لي جملتين عن المكتبة، and mention the word "library" twice.';
export const MIXED_REPLY = [
  'المكتبة مكان للقراءة والبحث. The library is open from 9:00 to 17:00 (الساعة ٩ إلى ٥).',
  '',
  '1. أولاً: اختر كتاباً from the catalogue.',
  '2. ثانياً: ابحث عن `library_id` في الجدول.',
  '',
  '- English item inside an Arabic answer',
  '- عنصر عربي',
  '',
  '> اقتباس عربي مع English words inside it.',
  '',
  '| الاسم | Value |',
  '| - | - |',
  '| جملة عربية تنتهي برقم 12 | text |',
  '',
  '```python',
  'def مكتبة(title):',
  '    return title[::-1]  # reverse',
  '```',
  '',
  `A_VERY_LONG_UNBROKEN_IDENTIFIER_${'x'.repeat(60)} and https://example.org/${'segment/'.repeat(10)}`,
].join('\n');

export const THREAD_TITLE = 'محادثة عن المكتبة · Library chat';

/** Opens a conversation whose messages are served from the fixture above. */
export async function openMixedConversation(page: Page, threadId: string) {
  await page.route(`**/api/chat/${threadId}/messages**`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        thread: { id: threadId, temporary: false, expiresAt: null },
        messages: [
          {
            id: `${threadId}-q`,
            role: 'user',
            parts: [{ type: 'text', text: MIXED_QUESTION }],
            metadata: { status: 'complete', createdAt: created },
          },
          {
            id: `${threadId}-a`,
            role: 'assistant',
            parts: [{ type: 'text', text: MIXED_REPLY }],
            metadata: { status: 'complete', createdAt: created },
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/artifacts?threadId=${threadId}`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ artifacts: [] }) }),
  );
  await page.goto(`/chat/${threadId}`);
  await expect(page.locator(`[data-message-id="${threadId}-a"]`)).toBeVisible();
  // The lazily loaded renderer has drawn the table and the code block.
  await expect(page.locator(`[data-message-id="${threadId}-a"] table`)).toBeVisible();
}

const SHARE_SLUG = 'rtl-mixed-share';
export async function openMixedShare(page: Page) {
  await page.route(`**/api/share-links/${SHARE_SLUG}`, (route) =>
    route.fulfill({
      json: {
        thread: { title: THREAD_TITLE, sharedAt: created },
        messages: [
          {
            id: 'u1',
            role: 'user',
            parts: [{ type: 'text', text: MIXED_QUESTION }],
            createdAt: created,
          },
          {
            id: 'a1',
            role: 'assistant',
            parts: [{ type: 'text', text: MIXED_REPLY }],
            createdAt: created,
          },
        ],
        artifacts: [],
        snapshot: true,
        expiresAt: null,
      },
    }),
  );
  await page.goto(`/share/${SHARE_SLUG}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('table').first()).toBeVisible();
}

// The sweep ------------------------------------------------------------------

export interface SweepPage {
  name: string;
  /** Needs a signed-in person (the others are for a visitor). */
  signedIn: boolean;
  open: (page: Page, ids: { threadId: string }) => Promise<void>;
}

export const SWEEP: SweepPage[] = [
  {
    name: 'sign-in',
    signedIn: false,
    open: async (page) => {
      await page.goto('/auth/login');
      await expect(page.locator('form button[type="submit"]')).toBeVisible();
    },
  },
  {
    name: 'chat-home',
    signedIn: true,
    open: async (page) => {
      await page.goto('/');
      await expect(page.locator('textarea')).toBeVisible();
    },
  },
  {
    name: 'conversation-mixed',
    signedIn: true,
    open: (page, { threadId }) => openMixedConversation(page, threadId),
  },
  {
    name: 'settings-customization',
    signedIn: true,
    open: async (page) => {
      await page.goto('/settings/customization');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    },
  },
  {
    name: 'settings-account',
    signedIn: true,
    open: async (page) => {
      await page.goto('/settings/account');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    },
  },
  {
    name: 'share',
    signedIn: false,
    open: (page) => openMixedShare(page),
  },
  {
    name: 'projects',
    signedIn: true,
    open: async (page) => {
      await page.goto('/projects');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    },
  },
];

/** The administration console stays English, but its layout mirrors too: no half-mirrored page. */
export const ADMIN_SWEEP: SweepPage[] = [
  {
    name: 'admin-overview',
    signedIn: true,
    open: async (page) => {
      await page.goto('/admin');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    },
  },
  {
    name: 'admin-users',
    signedIn: true,
    open: async (page) => {
      await page.goto('/admin/users');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    },
  },
];

// Reading order ----------------------------------------------------------------

export interface FocusStop {
  label: string;
  /** The input type, or the tag. */
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Presses Tab through the page and records where focus lands (until it leaves the page or `max` stops). */
export async function tabOrder(page: Page, max = 14): Promise<FocusStop[]> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const stops: FocusStop[] = [];
  for (let index = 0; index < max; index++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return null;
      const rect = element.getBoundingClientRect();
      return {
        kind: element.getAttribute('type') || element.tagName.toLowerCase(),
        label:
          (element as HTMLInputElement).labels?.[0]?.textContent?.trim() ||
          element.getAttribute('aria-label') ||
          element.textContent?.trim().slice(0, 30) ||
          element.getAttribute('name') ||
          element.tagName.toLowerCase(),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    });
    if (!stop) break;
    stops.push(stop);
  }
  return stops;
}

/**
 * Reading order in right-to-left: each stop is lower than the one before, or on the same
 * line and to its left (the line runs right to left). A stop that is off screen (the
 * skip link before it is focused) is judged by where it appears once focused.
 */
export function readingOrderProblems(stops: FocusStop[], rtl: boolean): string[] {
  const problems: string[] = [];
  for (let index = 1; index < stops.length; index++) {
    const before = stops[index - 1];
    const stop = stops[index];
    if (!before || !stop) continue;
    const sameLine = Math.abs(stop.y + stop.height / 2 - (before.y + before.height / 2)) < 12;
    const center = (item: FocusStop) => item.x + item.width / 2;
    if (sameLine) {
      const onTheReadingSide = rtl
        ? center(stop) <= center(before)
        : center(stop) >= center(before);
      if (!onTheReadingSide)
        problems.push(
          `"${before.label}" -> "${stop.label}" goes against the reading direction on one line`,
        );
    } else if (stop.y < before.y - 12) {
      problems.push(`"${before.label}" -> "${stop.label}" jumps up the page`);
    }
  }
  return problems;
}
