import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://oci:oci_dev_password@localhost:5439/oci',
  },
  casing: 'snake_case',
  verbose: true,
  strict: true,
});
