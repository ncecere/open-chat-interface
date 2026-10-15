/**
 * Data the audit needs on the instance so that pages show content instead of empty states:
 * catalog models, a group, a project and a conversation. All made through the API, named for
 * the audit, and carrying no real data.
 */

const PROVIDER_LABEL = 'A11y audit provider';
export const AUDIT_MODELS = [
  { slug: 'a11y-audit-alpha', displayName: 'A11y audit alpha' },
  { slug: 'a11y-audit-beta', displayName: 'A11y audit beta' },
];

async function json(response, what) {
  if (!response.ok())
    throw new Error(
      `${what} failed: ${response.status()} ${(await response.text()).slice(0, 200)}`,
    );
  return response.json();
}

/** Two catalog models behind a provider that points at a closed local port: nothing is sent. */
export async function ensureCatalog(admin) {
  const { providers } = await json(await admin.get('/api/admin/providers'), 'Listing providers');
  let providerId = providers.find((provider) => provider.label === PROVIDER_LABEL)?.id;
  if (!providerId) {
    ({ id: providerId } = await json(
      await admin.post('/api/admin/providers', {
        data: {
          kind: 'openai-compatible',
          label: PROVIDER_LABEL,
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'a11y-audit-not-a-real-key',
        },
      }),
      'Creating the provider',
    ));
  }
  const { models } = await json(await admin.get('/api/admin/models'), 'Listing models');
  const existing = new Set(models.map((model) => model.slug));
  for (const [index, model] of AUDIT_MODELS.entries()) {
    if (existing.has(model.slug)) continue;
    await json(
      await admin.post('/api/admin/models', {
        data: {
          providerId,
          upstreamModelId: model.slug,
          slug: model.slug,
          displayName: model.displayName,
          sortOrder: 900 + index,
        },
      }),
      'Creating a model',
    );
  }
}

/** A group with the given account as its manager, for the administration and Settings pages. */
export async function createGroup(admin, managerEmail) {
  const name = `A11y audit group ${Date.now().toString(36)}`;
  const { id } = await json(
    await admin.post('/api/admin/groups', {
      data: { name, description: 'Made by the accessibility audit' },
    }),
    'Creating a group',
  );
  await json(
    await admin.post(`/api/admin/groups/${id}/members`, {
      data: { emails: [managerEmail], role: 'manager' },
    }),
    'Adding the group manager',
  );
  return { id, name };
}

export async function userIdFor(admin, email) {
  const { users } = await json(
    await admin.get(`/api/admin/users?search=${encodeURIComponent(email)}`),
    'Finding a user',
  );
  const found = users.find((user) => user.email === email);
  if (!found) throw new Error('The audit account is not in the user list');
  return found.id;
}
