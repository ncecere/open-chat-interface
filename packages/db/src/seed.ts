import {
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES_PER_MESSAGE,
} from '@oci/shared';
import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from './client.js';
import { instanceSetting, organization } from './schema/index.js';

export const DEFAULT_ORGANIZATION_SLUG = 'default';

const defaultSettings: Record<string, Record<string, unknown>> = {
  branding: {
    appName: 'Open Chat Interface',
    logoUrl: null,
    accentColor: null,
    loginMessage: null,
    defaultTheme: 'dark',
    colorTheme: 'neutral',
  },
  auth: {
    registrationMode: 'invite_only',
    emailVerificationRequired: true,
    localAuthEnabled: true,
    sessionLifetimeDays: 30,
    sessionRefreshDays: 1,
  },
  features: {
    shareLinks: true,
    temporaryChat: true,
    webSearch: false,
    attachments: true,
    branching: true,
    memory: false,
  },
  storage: {
    driver: 'local',
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxFilesPerMessage: DEFAULT_MAX_FILES_PER_MESSAGE,
    allowedMimeTypes: [...DEFAULT_ALLOWED_MIME_TYPES],
    s3: {
      bucket: '',
      region: 'us-east-1',
      endpoint: null,
      accessKeyId: '',
      encryptedSecretAccessKey: null,
      forcePathStyle: false,
    },
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

/**
 * Creates the default organization and instance settings. Idempotent, so it is
 * safe to run on every boot: a fresh deployment needs it, and an existing one
 * is left untouched.
 */
export async function seedDatabase(db: Database): Promise<void> {
  // Insert first and ignore a conflict rather than checking then inserting:
  // two replicas booting together would otherwise both see an empty table.
  // organization.slug carries a unique index, so exactly one insert wins.
  await db
    .insert(organization)
    .values({ slug: DEFAULT_ORGANIZATION_SLUG, name: 'Open Chat Interface' })
    .onConflictDoNothing({ target: organization.slug });

  const [org] = await db
    .select()
    .from(organization)
    .where(eq(organization.slug, DEFAULT_ORGANIZATION_SLUG))
    .limit(1);

  if (!org) {
    throw new Error('Failed to create default organization');
  }

  for (const [key, value] of Object.entries(defaultSettings)) {
    await db
      .insert(instanceSetting)
      .values({ organizationId: org.id, key, value })
      .onConflictDoNothing({ target: [instanceSetting.organizationId, instanceSetting.key] });
  }

  // Quota policies are created by administrators; none are seeded so a fresh
  // instance is unlimited until an operator opts in.
}

/** CLI entry point for `pnpm db:seed`. */
async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to seed');
  }

  const { db, sql } = createDatabase(connectionString, { max: 1 });
  await seedDatabase(db);
  await sql.end();
  console.log('Seed complete.');
}

// Only run when invoked directly, not when imported by the server.
if (process.argv[1]?.includes('seed')) {
  main().catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  });
}
