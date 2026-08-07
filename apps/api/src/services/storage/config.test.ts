import { updateInstanceSettingsSchema } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import type { S3StorageSettings } from '../settings.js';
import { applyS3SettingsPatch, getS3ConfigurationIssues, toPublicS3Settings } from './config.js';

const completeSettings: S3StorageSettings = {
  bucket: 'attachments',
  region: 'us-east-1',
  endpoint: 'https://s3.example.com',
  accessKeyId: 'access-key',
  encryptedSecretAccessKey: 'encrypted-secret',
  forcePathStyle: true,
};

describe('toPublicS3Settings', () => {
  it('exposes credential presence without returning encrypted material', () => {
    expect(toPublicS3Settings(completeSettings)).toEqual({
      bucket: 'attachments',
      region: 'us-east-1',
      endpoint: 'https://s3.example.com',
      accessKeyId: 'access-key',
      forcePathStyle: true,
      hasCredential: true,
    });
    expect(toPublicS3Settings(completeSettings)).not.toHaveProperty('encryptedSecretAccessKey');
  });
});

describe('applyS3SettingsPatch', () => {
  const encrypt = (secret: string) => `encrypted:${secret}`;

  it('keeps the encrypted credential when the secret is omitted or blank', () => {
    expect(applyS3SettingsPatch(completeSettings, { bucket: 'new' }, encrypt)).toMatchObject({
      bucket: 'new',
      encryptedSecretAccessKey: 'encrypted-secret',
    });
    expect(applyS3SettingsPatch(completeSettings, { secretAccessKey: '' }, encrypt)).toMatchObject({
      encryptedSecretAccessKey: 'encrypted-secret',
    });
  });

  it('replaces and clears the encrypted credential explicitly', () => {
    expect(
      applyS3SettingsPatch(completeSettings, { secretAccessKey: 'replacement' }, encrypt),
    ).toMatchObject({ encryptedSecretAccessKey: 'encrypted:replacement' });
    expect(
      applyS3SettingsPatch(completeSettings, { secretAccessKey: null }, encrypt),
    ).toMatchObject({ encryptedSecretAccessKey: null });
  });
});

describe('getS3ConfigurationIssues', () => {
  it('accepts a complete S3 configuration', () => {
    expect(getS3ConfigurationIssues(completeSettings)).toEqual([]);
  });

  it('reports every required driver field and unsafe endpoint protocols', () => {
    expect(
      getS3ConfigurationIssues({
        ...completeSettings,
        bucket: ' ',
        region: '',
        endpoint: 'ftp://storage.example.com',
        accessKeyId: '',
        encryptedSecretAccessKey: null,
      }),
    ).toEqual([
      { field: 'bucket', message: 'S3 bucket is required.' },
      { field: 'region', message: 'S3 region is required.' },
      { field: 'accessKeyId', message: 'S3 access key ID is required.' },
      { field: 'secretAccessKey', message: 'S3 secret access key is required.' },
      { field: 'endpoint', message: 'S3 endpoint must use HTTP or HTTPS.' },
    ]);
  });

  it('rejects endpoint URLs containing embedded credentials', () => {
    expect(
      getS3ConfigurationIssues({
        ...completeSettings,
        endpoint: 'https://user:password@s3.example.com',
      }),
    ).toContainEqual({
      field: 'endpoint',
      message: 'S3 endpoint must not include credentials.',
    });
  });
});

describe('S3 credential patch schema', () => {
  it.each([
    ['keep by omission', {}],
    ['keep by blank value', { secretAccessKey: '' }],
    ['replace', { secretAccessKey: 'replacement' }],
    ['clear', { secretAccessKey: null }],
  ])('supports %s', (_name, s3) => {
    expect(updateInstanceSettingsSchema.safeParse({ storage: { s3 } }).success).toBe(true);
  });

  it('rejects the encrypted storage field', () => {
    const result = updateInstanceSettingsSchema.safeParse({
      storage: { s3: { encryptedSecretAccessKey: 'ciphertext' } },
    });
    expect(result.success).toBe(false);
  });
});
