import { describe, expect, it } from 'vitest';
import { validateUpload } from '../../services/attachments/validate.js';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=',
  'base64',
);

function validate(overrides: Partial<Parameters<typeof validateUpload>[0]> = {}) {
  return validateUpload({
    filename: 'upload.txt',
    declaredMimeType: 'text/plain',
    bytes: Buffer.from('plain UTF-8 text\n'),
    allowedMimeTypes: ['text/plain', 'application/json', 'image/png'],
    maxFileBytes: 1024 * 1024,
    ...overrides,
  });
}

describe('unit: attachment content validation', () => {
  it('uses binary magic bytes instead of a spoofed declared MIME type', async () => {
    const file = await validate({
      filename: 'not-really-text.txt',
      declaredMimeType: 'text/plain',
      bytes: ONE_PIXEL_PNG,
    });

    expect(file.mimeType).toBe('image/png');
  });

  it('rejects a detected binary format when that real type is not allowed', async () => {
    await expect(
      validate({
        filename: 'fake.txt',
        declaredMimeType: 'text/plain',
        bytes: ONE_PIXEL_PNG,
        allowedMimeTypes: ['text/plain'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });

  it('names the refused type with the right article', async () => {
    // A ZIP renamed to .png: "an application/zip", not "a application/zip".
    const zip = Buffer.from('504b0304140000000000', 'hex');
    await expect(
      validate({ filename: 'disguised.png', declaredMimeType: 'image/png', bytes: zip }),
    ).rejects.toMatchObject({
      message: 'disguised.png is an application/zip file, which is not allowed here',
    });
    await expect(
      validate({ filename: 'p.png', bytes: ONE_PIXEL_PNG, allowedMimeTypes: ['text/plain'] }),
    ).rejects.toMatchObject({ message: 'p.png is an image/png file, which is not allowed here' });
  });

  it('accepts printable UTF-8 as text but rejects binary/control-heavy content', async () => {
    await expect(
      validate({ declaredMimeType: 'application/octet-stream', bytes: Buffer.from('safe text') }),
    ).resolves.toMatchObject({ mimeType: 'text/plain' });

    await expect(
      validate({ bytes: Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02, 0x03]) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('parses JSON instead of trusting its extension or content type', async () => {
    await expect(
      validate({
        filename: 'payload.json',
        declaredMimeType: 'application/json; charset=utf-8',
        bytes: Buffer.from('{"safe":true}'),
      }),
    ).resolves.toMatchObject({ mimeType: 'application/json' });

    await expect(
      validate({
        filename: 'payload.json',
        declaredMimeType: 'application/json',
        bytes: Buffer.from('{not valid JSON}'),
      }),
    ).rejects.toThrow('does not contain valid JSON');
  });

  it('enforces empty and maximum-size limits', async () => {
    await expect(validate({ bytes: Buffer.alloc(0) })).rejects.toThrow('is empty');
    await expect(validate({ bytes: Buffer.alloc(5), maxFileBytes: 4 })).rejects.toThrow(
      'exceeds the',
    );
  });

  it('strips path components and control characters from filenames', async () => {
    await expect(
      validate({ filename: '../../private\\nested/\u0000report.txt' }),
    ).resolves.toMatchObject({ filename: 'report.txt' });
  });
});
