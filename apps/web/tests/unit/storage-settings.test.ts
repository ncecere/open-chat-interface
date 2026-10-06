import { describe, expect, it } from 'vitest';
import {
  bytesFromMb,
  changedStorageSettings,
  makeDraft,
  mbFromBytes,
  parseMimeTypes,
  type StorageSettings,
  validateDraft,
} from '../../src/routes/admin/storage/storage-draft';

function settings(hasCredential = true): StorageSettings {
  return {
    driver: 'local',
    localPath: '/data/attachments',
    maxFileBytes: 10_485_760,
    maxFilesPerMessage: 5,
    allowedMimeTypes: ['image/png', 'application/pdf'],
    s3: {
      bucket: 'attachments',
      region: 'us-east-1',
      endpoint: null,
      accessKeyId: 'access-id',
      forcePathStyle: false,
      hasCredential,
    },
  };
}

function s3Draft() {
  return { ...makeDraft(settings()), driver: 's3' as const };
}

const requiredSecret = 'A secret access key is required for the S3 driver.';

describe('storage drafts and patches', () => {
  it('creates editable strings without including the local path or saved credential state', () => {
    expect(makeDraft(settings())).toEqual({
      driver: 'local',
      maxFileMb: '10',
      maxFilesPerMessage: '5',
      allowedMimeTypes: 'image/png\napplication/pdf',
      bucket: 'attachments',
      region: 'us-east-1',
      endpoint: '',
      accessKeyId: 'access-id',
      forcePathStyle: false,
    });
    const saved = settings();
    saved.s3.endpoint = 'https://s3.example.com';
    expect(makeDraft(saved).endpoint).toBe(saved.s3.endpoint);
  });

  it('parses commas and newlines, trims, removes empty entries and deduplicates in order', () => {
    expect(parseMimeTypes(' image/png, application/pdf\nimage/png\n, text/plain ,')).toEqual([
      'image/png',
      'application/pdf',
      'text/plain',
    ]);
    expect(parseMimeTypes(' ,\n ')).toEqual([]);
  });

  it('keeps credentials out of unchanged patches, even if an unused replacement is present', () => {
    const saved = settings();
    const draft = makeDraft(saved);
    expect(changedStorageSettings(saved, draft, 'keep', '')).toEqual({});
    expect(changedStorageSettings(saved, draft, 'keep', 'unused-secret')).toEqual({});
  });

  it('keeps a saved credential when replacement input is blank', () => {
    const saved = settings();
    expect(changedStorageSettings(saved, makeDraft(saved), 'replace', '')).toEqual({});
  });

  it('clears only an existing credential and never sends an unused replacement', () => {
    const saved = settings();
    expect(changedStorageSettings(saved, makeDraft(saved), 'clear', 'unused-secret')).toEqual({
      s3: { secretAccessKey: null },
    });
    const empty = settings(false);
    expect(changedStorageSettings(empty, makeDraft(empty), 'clear', '')).toEqual({});
  });

  it.each([true, false])(
    'replaces a credential without trimming it (saved: %s)',
    (hasCredential) => {
      const saved = settings(hasCredential);
      expect(
        changedStorageSettings(saved, makeDraft(saved), 'replace', ' secret with spaces '),
      ).toEqual({
        s3: { secretAccessKey: ' secret with spaces ' },
      });
    },
  );

  it('combines changes from all three tabs into one minimal patch', () => {
    const saved = settings();
    const draft = {
      ...makeDraft(saved),
      driver: 's3' as const,
      bucket: ' new-bucket ',
      region: ' eu-west-1 ',
      endpoint: ' https://s3.example.com ',
      accessKeyId: ' new-access-id ',
      forcePathStyle: true,
      maxFileMb: '2',
      maxFilesPerMessage: '2',
      allowedMimeTypes: 'text/plain, image/png\ntext/plain',
    };
    expect(changedStorageSettings(saved, draft, 'replace', 'new-secret')).toEqual({
      driver: 's3',
      maxFileBytes: 2 * 1024 * 1024,
      maxFilesPerMessage: 2,
      allowedMimeTypes: ['text/plain', 'image/png'],
      s3: {
        bucket: 'new-bucket',
        region: 'eu-west-1',
        endpoint: 'https://s3.example.com',
        accessKeyId: 'new-access-id',
        forcePathStyle: true,
        secretAccessKey: 'new-secret',
      },
    });
    expect(saved).toEqual(settings());
    expect(draft.bucket).toBe(' new-bucket ');
  });

  it('omits normalized unchanged fields and treats MIME order as meaningful', () => {
    const saved = settings();
    const draft = {
      ...makeDraft(saved),
      bucket: ' attachments ',
      region: ' us-east-1 ',
      accessKeyId: ' access-id ',
      endpoint: ' ',
      maxFilesPerMessage: '05',
      allowedMimeTypes: 'image/png, application/pdf, image/png',
    };
    expect(changedStorageSettings(saved, draft, 'keep', '')).toEqual({});
    draft.allowedMimeTypes = 'application/pdf,image/png';
    expect(changedStorageSettings(saved, draft, 'keep', '')).toEqual({
      allowedMimeTypes: ['application/pdf', 'image/png'],
    });
  });

  it('allows explicitly empty MIME lists and clears an endpoint using null', () => {
    const saved = settings();
    saved.s3.endpoint = 'https://s3.example.com';
    const draft = { ...makeDraft(saved), allowedMimeTypes: '', endpoint: ' ' };
    expect(validateDraft(draft, true, 'keep', '')).toEqual({});
    expect(changedStorageSettings(saved, draft, 'keep', '')).toEqual({
      allowedMimeTypes: [],
      s3: { endpoint: null },
    });
  });

  it('does not serialize invalid numeric drafts into patches', () => {
    const saved = settings();
    const draft = { ...makeDraft(saved), maxFileMb: 'abc', maxFilesPerMessage: 'NaN' };
    expect(changedStorageSettings(saved, draft, 'keep', '')).toEqual({});
    expect(validateDraft(draft, true, 'keep', '')).toEqual({
      maxFileMb: 'File size must be a positive number of MB.',
      maxFilesPerMessage: 'File count must be a positive whole number.',
    });
  });
});

describe('storage draft validation', () => {
  it('caps the upload limit at 1,024 MB, as a role allowance is (#142)', () => {
    expect(
      validateDraft({ ...makeDraft(settings()), maxFileMb: '1024' }, true, 'keep', ''),
    ).toEqual({});
    expect(
      validateDraft({ ...makeDraft(settings()), maxFileMb: '100000' }, true, 'keep', ''),
    ).toEqual({ maxFileMb: 'File size can be at most 1,024 MB (1 GB).' });
  });

  it.each(['', '0', '-1', 'NaN', 'Infinity', '1e300'])('rejects an invalid size: %s', (value) => {
    const draft = { ...makeDraft(settings()), maxFileMb: value };
    expect(validateDraft(draft, true, 'keep', '')).toEqual({
      maxFileMb: 'File size must be a positive number of MB.',
    });
  });

  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])(
    'rejects an invalid count: %s',
    (value) => {
      const draft = { ...makeDraft(settings()), maxFilesPerMessage: value };
      expect(validateDraft(draft, true, 'keep', '')).toEqual({
        maxFilesPerMessage: 'File count must be a positive whole number.',
      });
    },
  );

  it('accepts a fraction of a MB and the largest allowed size', () => {
    for (const maxFileMb of ['0.5', '1.5', '1024']) {
      const draft = { ...makeDraft(settings()), maxFileMb, maxFilesPerMessage: '1' };
      expect(validateDraft(draft, true, 'keep', '')).toEqual({});
    }
  });

  it.each(['image', '/png', 'image/', 'image/png/extra', 'image /png'])(
    'reports the first invalid MIME type: %s',
    (mimeType) => {
      const draft = {
        ...makeDraft(settings()),
        allowedMimeTypes: `text/plain,${mimeType},invalid`,
      };
      expect(validateDraft(draft, true, 'keep', '')).toEqual({
        allowedMimeTypes: `“${mimeType}” is not a valid MIME type.`,
      });
    },
  );

  it.each([
    ['relative/path', 'Enter a valid absolute URL.'],
    ['ftp://s3.example.com', 'Endpoint must use HTTP or HTTPS.'],
    ['https://user@s3.example.com', 'Endpoint must not include credentials.'],
    ['https://user:password@s3.example.com', 'Endpoint must not include credentials.'],
  ])('validates endpoints even with the local driver: %s', (endpoint, message) => {
    const draft = { ...makeDraft(settings()), endpoint };
    expect(validateDraft(draft, true, 'keep', '')).toEqual({ endpoint: message });
  });

  it.each(['', ' ', 'http://localhost:9000', ' https://s3.example.com '])(
    'accepts optional or HTTP(S) endpoints: %s',
    (endpoint) => {
      const draft = { ...makeDraft(settings()), endpoint };
      expect(validateDraft(draft, true, 'keep', '')).toEqual({});
    },
  );

  it('requires S3 metadata only when S3 is active', () => {
    const draft = { ...makeDraft(settings(false)), bucket: ' ', region: '', accessKeyId: '\n' };
    expect(validateDraft(draft, false, 'keep', '')).toEqual({});
    expect(validateDraft({ ...draft, driver: 's3' }, false, 'keep', '')).toEqual({
      bucket: 'Bucket is required for the S3 driver.',
      region: 'Region is required for the S3 driver.',
      accessKeyId: 'Access key ID is required for the S3 driver.',
      secretAccessKey: requiredSecret,
    });
  });

  it('accepts keeping an existing S3 credential but rejects a missing one', () => {
    expect(validateDraft(s3Draft(), true, 'keep', '')).toEqual({});
    expect(validateDraft(s3Draft(), false, 'keep', '')).toEqual({
      secretAccessKey: requiredSecret,
    });
  });

  it('rejects clearing the active S3 credential but permits clearing with local storage', () => {
    expect(validateDraft(s3Draft(), true, 'clear', '')).toEqual({
      secretAccessKey: requiredSecret,
    });
    expect(validateDraft(makeDraft(settings()), true, 'clear', '')).toEqual({});
  });

  it.each([true, false])('requires a nonempty S3 replacement (saved: %s)', (hasCredential) => {
    // Preserve existing validation: blank replacement is omitted by patching, but cannot save S3.
    expect(validateDraft(s3Draft(), hasCredential, 'replace', '')).toEqual({
      secretAccessKey: requiredSecret,
    });
    expect(validateDraft(s3Draft(), hasCredential, 'replace', 'replacement')).toEqual({});
  });

  it('enforces the 2,048-character secret limit for either driver without trimming', () => {
    for (const draft of [makeDraft(settings()), s3Draft()]) {
      expect(validateDraft(draft, true, 'replace', 's'.repeat(2_048))).toEqual({});
      expect(validateDraft(draft, true, 'replace', 's'.repeat(2_049))).toEqual({
        secretAccessKey: 'Secret access key must be 2,048 characters or fewer.',
      });
      expect(validateDraft(draft, true, 'replace', ' ')).toEqual({});
    }
  });

  it('takes the file size in MB, as Roles & access does (#86)', () => {
    expect(mbFromBytes(26_214_400)).toBe('25');
    expect(mbFromBytes(1_500_000)).toBe('1.431');
    expect(bytesFromMb('0.5')).toBe(524_288);
    expect(bytesFromMb('')).toBeNaN();
    expect(bytesFromMb('-1')).toBeNaN();
    // A saved size that is not a round number of MB is not a change until edited.
    const odd = { ...settings(), maxFileBytes: 1_500_000 };
    expect(changedStorageSettings(odd, makeDraft(odd), 'keep', '')).toEqual({});
    expect(validateDraft({ ...makeDraft(odd), maxFileMb: 'abc' }, true, 'keep', '')).toMatchObject({
      maxFileMb: 'File size must be a positive number of MB.',
    });
  });
});
