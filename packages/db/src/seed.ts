import {
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES_PER_MESSAGE,
  USER_ROLES,
} from '@oci/shared';
import { eq } from 'drizzle-orm';
import { createDatabase } from './client.js';
import { instanceSetting, organization, roleQuota } from './schema/index.js';

export const DEFAULT_ORGANIZATION_SLUG = 'default';

const defaultSettings: Record<string, Record<string, unknown>> = {
  branding: {
    appName: 'Open Chat Interface',
    logoUrl: null,
    accentColor: null,
    loginMessage: null,
    defaultTheme: 'dark',
  },
  auth: {
    registrationMode: 'invite_only',
    emailVerificationRequired: true,
    localAuthEnabled: true,
  },
  features: {
    shareLinks: true,
    temporaryChat: true,
    canvas: false,
    mcp: false,
    webSearch: false,
    attachments: true,
    personas: true,
    branching: true,
  },
  storage: {
    driver: 'local',
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxFilesPerMessage: DEFAULT_MAX_FILES_PER_MESSAGE,
    allowedMimeTypes: [...DEFAULT_ALLOWED_MIME_TYPES],
  },
  search: {
    enabled: false,
    provider: null,
    baseUrl: null,
    encryptedApiKey: null,
    maxResults: 5,
  },
  smtp: {
    host: null,
    port: null,
    secure: false,
    fromAddress: null,
    username: null,
    encryptedPassword: null,
  },
  chat: {
    defaultSystemPrompt: null,
  },
};

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to seed');
  }

  const { db, sql } = createDatabase(connectionString, { max: 1 });

  const [existingOrg] = await db
    .select()
    .from(organization)
    .where(eq(organization.slug, DEFAULT_ORGANIZATION_SLUG))
    .limit(1);

  const org =
    existingOrg ??
    (
      await db
        .insert(organization)
        .values({ slug: DEFAULT_ORGANIZATION_SLUG, name: 'Open Chat Interface' })
        .returning()
    )[0];

  if (!org) {
    throw new Error('Failed to create default organization');
  }

  console.log(`Organization ready: ${org.id}`);

  for (const [key, value] of Object.entries(defaultSettings)) {
    await db
      .insert(instanceSetting)
      .values({ organizationId: org.id, key, value })
      .onConflictDoNothing({ target: [instanceSetting.organizationId, instanceSetting.key] });
  }
  console.log(`Seeded ${Object.keys(defaultSettings).length} setting groups.`);

  for (const role of USER_ROLES) {
    await db
      .insert(roleQuota)
      .values({ organizationId: org.id, role, enabled: false, windowHours: 24 })
      .onConflictDoNothing();
  }
  console.log('Seeded role quotas (disabled by default).');

  await sql.end();
  console.log('Seed complete.');
}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
