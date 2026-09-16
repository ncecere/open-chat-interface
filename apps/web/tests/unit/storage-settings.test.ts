import { describe, expect, it } from 'vitest';
import {
  changedStorageSettings,
  makeDraft,
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
      maxFileBytes: '10485760',
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
      maxFileBytes: '2048',
      maxFilesPerMessage: '2',
      allowedMimeTypes: 'text/plain, image/png\ntext/plain',
    };
    expect(changedStorageSettings(saved, draft, 'replace', 'new-secret')).toEqual({
      driver: 's3',
      maxFileBytes: 2048,
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

  it('does not serialize non-integer numeric drafts into patches', () => {
    const saved = settings();
    const draft = { ...makeDraft(saved), maxFileBytes: '1.5', maxFilesPerMessage: 'NaN' };
    expect(changedStorageSettings(saved, draft, 'keep', '')).toEqual({});
    expect(validateDraft(draft, true, 'keep', '')).toEqual({
      maxFileBytes: 'File size must be a positive whole number of bytes.',
      maxFilesPerMessage: 'File count must be a positive whole number.',
    });
  });
});

describe('storage draft validation', () => {
  it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'])(
    'rejects invalid size and count: %s',
    (value) => {
      const draft = { ...makeDraft(settings()), maxFileBytes: value, maxFilesPerMessage: value };
      expect(validateDraft(draft, true, 'keep', '')).toEqual({
        maxFileBytes: 'File size must be a positive whole number of bytes.',
        maxFilesPerMessage: 'File count must be a positive whole number.',
      });
    },
  );

  it('accepts positive safe integer bounds', () => {
    const draft = {
      ...makeDraft(settings()),
      maxFileBytes: '9007199254740991',
      maxFilesPerMessage: '1',
    };
    expect(validateDraft(draft, true, 'keep', '')).toEqual({});
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
});
