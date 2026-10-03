import { type APIRequestContext, expect } from '@playwright/test';

/**
 * Two catalog models these tests can rely on. CI starts from an empty catalog
 * while the local fixture seeds its own, so a test that needs models creates
 * them through the admin API rather than assuming they exist. Idempotent: an
 * existing provider or model with the same label or slug is reused.
 *
 * The provider points at a closed local port; nothing here sends a message.
 */
export const E2E_MODELS = [
  { slug: 'e2e-catalog-alpha', displayName: 'E2E catalog alpha' },
  { slug: 'e2e-catalog-beta', displayName: 'E2E catalog beta' },
] as const;

const PROVIDER_LABEL = 'E2E catalog provider';

/** Needs an administrator's request context. */
export async function ensureCatalogModels(admin: APIRequestContext) {
  const providers = await admin.get('/api/admin/providers');
  expect(providers.ok(), await providers.text()).toBe(true);
  const listed = (await providers.json()) as { providers: Array<{ id: string; label: string }> };
  let providerId = listed.providers.find((provider) => provider.label === PROVIDER_LABEL)?.id;
  if (!providerId) {
    const created = await admin.post('/api/admin/providers', {
      data: {
        kind: 'openai-compatible',
        label: PROVIDER_LABEL,
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'e2e-not-a-real-key',
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    providerId = ((await created.json()) as { id: string }).id;
  }

  const models = await admin.get('/api/admin/models');
  expect(models.ok(), await models.text()).toBe(true);
  const existing = new Set(
    ((await models.json()) as { models: Array<{ slug: string }> }).models.map(
      (model) => model.slug,
    ),
  );
  for (const [index, model] of E2E_MODELS.entries()) {
    if (existing.has(model.slug)) continue;
    const created = await admin.post('/api/admin/models', {
      data: {
        providerId,
        upstreamModelId: model.slug,
        slug: model.slug,
        displayName: model.displayName,
        sortOrder: 900 + index,
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
  }
  return E2E_MODELS;
}
