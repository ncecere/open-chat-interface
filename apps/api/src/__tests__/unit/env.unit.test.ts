import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../config/env.js';

const required = {
  DATABASE_URL: 'postgres://oci:secret@postgres:5432/oci',
  AUTH_SECRET: 'a'.repeat(64),
  ENCRYPTION_KEY: 'b'.repeat(64),
};

/**
 * Docker Compose passes `${NAME:-}` through as an empty string, so a variable
 * the operator never set arrives as "" rather than missing. For optional
 * settings that must mean "unset"; for required secrets it must still fail.
 */
describe('parseEnv', () => {
  it('treats blank optional variables as unset, as Compose passes them', () => {
    const env = parseEnv({
      ...required,
      INITIAL_ADMIN_EMAIL: 'admin@example.test',
      INITIAL_ADMIN_PASSWORD: '',
      AUTH_TRUSTED_ORIGINS: '',
      REDIS_URL: ' ',
      BACKUP_PG_BIN_DIR: '',
      DISPLAY_TIMEZONE: '',
      RETENTION_TRASH_DAYS: '',
      METRICS_TOKEN: '',
    });
    expect(env.INITIAL_ADMIN_EMAIL).toBe('admin@example.test');
    expect(env.INITIAL_ADMIN_PASSWORD).toBeUndefined();
    expect(env.AUTH_TRUSTED_ORIGINS).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.BACKUP_PG_BIN_DIR).toBeUndefined();
    expect(env.DISPLAY_TIMEZONE).toBeUndefined();
    expect(env.RETENTION_TRASH_DAYS).toBeUndefined();
    expect(env.METRICS_TOKEN).toBeUndefined();
  });

  it('starts with neither administrator variable set', () => {
    const env = parseEnv({ ...required, INITIAL_ADMIN_EMAIL: '', INITIAL_ADMIN_PASSWORD: '' });
    expect(env.INITIAL_ADMIN_EMAIL).toBeUndefined();
    expect(env.INITIAL_ADMIN_PASSWORD).toBeUndefined();
  });

  it('uses the default for a blank variable that has one', () => {
    const env = parseEnv({
      ...required,
      API_PORT: '',
      APP_URL: '',
      RUN_MIGRATIONS: '',
      LOG_LEVEL: '',
      STORAGE_LOCAL_PATH: '',
      CHAT_STREAM_TTL_SECONDS: '',
      OTEL_SERVICE_NAME: '',
    });
    expect(env).toMatchObject({
      API_PORT: 3000,
      APP_URL: 'http://localhost:5173',
      RUN_MIGRATIONS: true,
      LOG_LEVEL: 'info',
      STORAGE_LOCAL_PATH: './data/storage',
      CHAT_STREAM_TTL_SECONDS: 900,
      OTEL_SERVICE_NAME: 'oci-api',
    });
  });

  it('still validates optional variables that are set', () => {
    expect(() => parseEnv({ ...required, INITIAL_ADMIN_PASSWORD: 'short' })).toThrow(
      /INITIAL_ADMIN_PASSWORD/,
    );
    expect(() => parseEnv({ ...required, INITIAL_ADMIN_EMAIL: 'not-an-email' })).toThrow(
      /INITIAL_ADMIN_EMAIL/,
    );
    expect(
      parseEnv({ ...required, INITIAL_ADMIN_PASSWORD: 'long-enough-password' })
        .INITIAL_ADMIN_PASSWORD,
    ).toBe('long-enough-password');
  });

  it('never accepts a blank required secret or database URL', () => {
    for (const name of ['AUTH_SECRET', 'ENCRYPTION_KEY', 'DATABASE_URL'] as const) {
      expect(() => parseEnv({ ...required, [name]: '' }), name).toThrow(new RegExp(name));
      const { [name]: _omitted, ...rest } = required;
      expect(() => parseEnv(rest), name).toThrow(new RegExp(name));
    }
    expect(() => parseEnv({ ...required, AUTH_SECRET: 'too-short' })).toThrow(
      /AUTH_SECRET must be at least 32 characters/,
    );
  });
});
