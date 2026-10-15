import { expect, type Page } from '@playwright/test';

/**
 * A conversation that carries data classes, for the accessibility specs
 * (v0.14, #395). The conversation itself is real (created through the API with
 * the signed-in session); the model list and what classification says about it
 * are routed, so the scans need neither a configured provider nor the instance
 * to have classification turned on.
 */
export const LABELLED = {
  approved: 'Approved model',
  plain: 'Plain model',
  className: 'Student records',
};

const model = (slug: string, displayName: string, sortOrder: number) => ({
  id: `model-${slug}`,
  slug,
  displayName,
  description: 'Deterministic test model',
  providerId: 'provider-test',
  providerKind: 'openai-compatible',
  providerLabel: 'Test Gateway',
  upstreamModelId: slug,
  capabilities: [],
  labId: null,
  contextWindow: 128000,
  maxOutputTokens: 8192,
  supportedEfforts: [],
  isDefault: sortOrder === 0,
  sortOrder,
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
  status,
  headers,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/** Routes the catalog and classification, then opens a new conversation. Returns its id. */
export async function openLabelledConversation(
  page: Page,
  options: { refuseSends?: boolean; plainUnblockedAtFirst?: boolean } = {},
): Promise<{ threadId: string; blockPlain: () => void }> {
  // With plainUnblockedAtFirst the plain model can be picked until blockPlain()
  // is called and the page asks again (adding a label does): the way a
  // conversation gets labelled after a model was chosen.
  let plainBlocked = !options.plainUnblockedAtFirst;
  const created = await page.request.post('/api/threads', { data: { title: 'Labelled' } });
  expect(created.ok()).toBe(true);
  const { thread } = (await created.json()) as { thread: { id: string } };

  await page.route('**/api/models', (route) =>
    route.fulfill(
      json({
        models: [model('approved', LABELLED.approved, 0), model('plain', LABELLED.plain, 1)],
      }),
    ),
  );
  await page.route('**/api/data-classes', (route) =>
    route.fulfill(json({ classes: [{ id: 'c-extra', name: 'Research data' }] })),
  );
  await page.route('**/api/threads/*/data-classes', (route) =>
    route.fulfill(json({ classes: [] }, 201)),
  );
  await page.route('**/api/classification?**', (route) =>
    route.fulfill(
      json({
        mode: 'block',
        classes: [
          {
            id: 'c-project',
            name: LABELLED.className,
            reasons: ['project'],
            removable: false,
          },
          {
            id: 'c-connector',
            name: 'Payroll',
            reasons: ['connector'],
            connectorNames: ['SIS'],
            removable: false,
          },
          { id: 'c-person', name: 'Health data', reasons: ['person'], removable: true },
          {
            id: 'c-kept',
            name: 'Grades',
            reasons: ['kept'],
            origins: ['project'],
            removable: false,
          },
        ],
        models: [
          { slug: 'approved', displayName: LABELLED.approved, status: 'ok', missing: [] },
          plainBlocked
            ? {
                slug: 'plain',
                displayName: LABELLED.plain,
                status: 'blocked',
                missing: [
                  { id: 'c-project', name: LABELLED.className },
                  { id: 'c-connector', name: 'Payroll' },
                ],
              }
            : { slug: 'plain', displayName: LABELLED.plain, status: 'ok', missing: [] },
        ],
      }),
    ),
  );
  if (options.refuseSends)
    await page.route('**/api/chat', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill(
            json(
              {
                error: {
                  code: 'DATA_CLASS_BLOCKED',
                  message: `Your message was not sent. ${LABELLED.plain} is not approved for ${LABELLED.className} and Payroll, which this conversation carries. Choose a model that is approved for them.`,
                  details: {
                    point: 'send',
                    model: { slug: 'plain', displayName: LABELLED.plain },
                    missing: [
                      { id: 'c-project', name: LABELLED.className, reasons: ['project'] },
                      { id: 'c-connector', name: 'Payroll', reasons: ['connector'] },
                    ],
                    approvedModels: [{ slug: 'approved', displayName: LABELLED.approved }],
                  },
                },
              },
              403,
              { 'X-OCI-Message-Saved': 'no' },
            ),
          )
        : route.continue(),
    );
  await page.goto(`/chat/${thread.id}`);
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  return {
    threadId: thread.id,
    blockPlain: () => {
      plainBlocked = true;
    },
  };
}
