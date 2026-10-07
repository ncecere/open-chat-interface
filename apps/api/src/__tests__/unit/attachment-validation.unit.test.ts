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

  it('names a refused type in words, not as a MIME type (#180)', async () => {
    // A ZIP renamed to .png.
    const zip = Buffer.from('504b0304140000000000', 'hex');
    await expect(
      validate({ filename: 'disguised.png', declaredMimeType: 'image/png', bytes: zip }),
    ).rejects.toMatchObject({
      message:
        'disguised.png is a ZIP archive, which is not allowed here. You can attach images and text files.',
    });
    await expect(
      validate({ filename: 'p.png', bytes: ONE_PIXEL_PNG, allowedMimeTypes: ['text/plain'] }),
    ).rejects.toMatchObject({
      message: 'p.png is a PNG image, which is not allowed here. You can attach text files.',
    });
    // A Windows program renamed to .png, as in the QA walk ("MZ" header).
    const exe = Buffer.concat([
      Buffer.from('4d5a90000300000004000000ffff0000', 'hex'),
      Buffer.alloc(64),
    ]);
    const refusal = validate({
      filename: 'walk3-fake.png',
      declaredMimeType: 'image/png',
      bytes: exe,
    });
    await expect(refusal).rejects.toMatchObject({
      message:
        'walk3-fake.png is a Windows program, which is not allowed here. You can attach images and text files.',
    });
  });

  it('says "this type of file" for a type with no common name', async () => {
    const { fileKind } = await import('../../services/attachments/validate.js');
    expect(fileKind('application/x-unheard-of')).toBeNull();
    expect(fileKind('image/svg+xml')).toBe('an SVG image');
    expect(fileKind('image/heic')).toBe('a HEIC image');
    expect(fileKind('audio/mpeg')).toBe('an audio file');
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
    await expect(validate({ bytes: Buffer.alloc(0) })).rejects.toThrow(
      'upload.txt is empty, so it was not uploaded.',
    );
    await expect(validate({ bytes: Buffer.alloc(5), maxFileBytes: 4 })).rejects.toThrow(
      'upload.txt is larger than the 0 KB limit',
    );
  });

  it('words refusals as whole sentences, as the composer does, and says what is allowed (#209)', async () => {
    const MB = 1024 * 1024;
    await expect(
      validate({
        filename: 'walk3-big.txt',
        bytes: Buffer.alloc(21 * MB, 'x'),
        maxFileBytes: 20 * MB,
      }),
    ).rejects.toMatchObject({
      message: 'walk3-big.txt is larger than the 20 MB limit, so it was not uploaded.',
    });
    await expect(
      validate({ bytes: Buffer.alloc(2 * MB, 'x'), maxFileBytes: 1.5 * MB }),
    ).rejects.toMatchObject({
      message: 'upload.txt is larger than the 1.5 MB limit, so it was not uploaded.',
    });
    // The instance's default types.
    await expect(
      validate({
        filename: 'walk3-archive.zip',
        declaredMimeType: 'application/zip',
        bytes: Buffer.from('504b0304140000000000', 'hex'),
        allowedMimeTypes: [
          'image/png',
          'image/jpeg',
          'image/webp',
          'image/gif',
          'application/pdf',
          'text/plain',
          'text/markdown',
        ],
      }),
    ).rejects.toMatchObject({
      message:
        'walk3-archive.zip is a ZIP archive, which is not allowed here. You can attach images, PDFs and text files.',
    });
    // No allowed type with a common name: nothing to list.
    await expect(
      validate({ filename: 'notes.txt', allowedMimeTypes: ['application/x-unheard-of'] }),
    ).rejects.toMatchObject({
      message: 'notes.txt is a type of file that is not allowed here.',
    });
  });

  it('strips path components and control characters from filenames', async () => {
    await expect(
      validate({ filename: '../../private\\nested/\u0000report.txt' }),
    ).resolves.toMatchObject({ filename: 'report.txt' });
  });
});
