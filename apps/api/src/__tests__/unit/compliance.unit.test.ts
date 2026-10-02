import {
  COMPLIANCE_STORAGE_PREFIX,
  placeLegalHoldSchema,
  updateComplianceSettingsSchema,
} from '@oci/shared';
import { describe, expect, it, vi } from 'vitest';
import { summarizeMessageParts } from '../../services/compliance/content.js';
import { complianceSlot } from '../../services/compliance/export.js';
import {
  HELD_ACCOUNT_DELETION_MESSAGE,
  isLegalHoldViolation,
} from '../../services/compliance/hold-errors.js';
import {
  applyComplianceSettingsPatch,
  changedComplianceFields,
  complianceKeyPrefix,
  normalizeComplianceSettings,
  toPublicComplianceSettings,
} from '../../services/compliance/settings.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

describe('compliance settings', () => {
  it('defaults to off, daily, audit events only, and keeping exported objects', () => {
    const settings = normalizeComplianceSettings({});
    expect(settings).toMatchObject({
      enabled: false,
      schedule: 'daily',
      destination: 'storage',
      prefix: 'oci-compliance/',
      includeContent: false,
      keepDays: null,
    });
    expect(toPublicComplianceSettings(settings).s3.hasCredential).toBe(false);
    expect(complianceKeyPrefix(settings)).toBe(COMPLIANCE_STORAGE_PREFIX);
    expect(complianceKeyPrefix({ ...settings, destination: 'separate', prefix: 'x/' })).toBe('x/');
  });

  it('keeps secrets write-only and reports which fields changed', () => {
    const before = normalizeComplianceSettings({ s3: { encryptedSecretAccessKey: 'old' } });
    const kept = applyComplianceSettingsPatch(before, { s3: { secretAccessKey: '' } });
    expect(kept.s3.encryptedSecretAccessKey).toBe('old');
    const replaced = applyComplianceSettingsPatch(before, {
      includeContent: true,
      keepDays: 30,
      s3: { secretAccessKey: 'new-secret', bucket: 'records' },
    });
    expect(replaced.s3.encryptedSecretAccessKey).not.toBe('old');
    expect(replaced.s3.encryptedSecretAccessKey).not.toContain('new-secret');
    expect(changedComplianceFields(before, replaced)).toEqual([
      'includeContent',
      'keepDays',
      's3.bucket',
      's3.secretAccessKey',
    ]);
    const cleared = applyComplianceSettingsPatch(before, { s3: { secretAccessKey: null } });
    expect(cleared.s3.encryptedSecretAccessKey).toBeNull();
    expect(toPublicComplianceSettings(replaced)).not.toHaveProperty('s3.encryptedSecretAccessKey');
  });

  it('validates patches and hold requests', () => {
    expect(updateComplianceSettingsSchema.safeParse({}).success).toBe(false);
    expect(updateComplianceSettingsSchema.safeParse({ schedule: 'weekly' }).success).toBe(false);
    expect(updateComplianceSettingsSchema.safeParse({ keepDays: 0 }).success).toBe(false);
    expect(updateComplianceSettingsSchema.safeParse({ keepDays: null }).success).toBe(true);
    expect(updateComplianceSettingsSchema.safeParse({ prefix: '../x/' }).success).toBe(false);
    expect(updateComplianceSettingsSchema.safeParse({ other: true }).success).toBe(false);
    expect(placeLegalHoldSchema.safeParse({ reason: 'x' }).success).toBe(false);
    expect(placeLegalHoldSchema.safeParse({ email: 'a@b.c', reason: ' ' }).success).toBe(false);
    expect(placeLegalHoldSchema.parse({ email: ' A@B.C ', reason: ' Matter ' })).toEqual({
      email: 'a@b.c',
      reason: 'Matter',
    });
  });

  it('finds the most recent hourly and daily slot', () => {
    expect(complianceSlot(new Date('2026-10-02T05:59:59Z'), 'hourly', 3).toISOString()).toBe(
      '2026-10-02T05:00:00.000Z',
    );
    expect(complianceSlot(new Date('2026-10-02T05:00:00Z'), 'daily', 3).toISOString()).toBe(
      '2026-10-02T03:00:00.000Z',
    );
    expect(complianceSlot(new Date('2026-10-02T02:00:00Z'), 'daily', 3).toISOString()).toBe(
      '2026-10-01T03:00:00.000Z',
    );
  });
});

describe('message content in the export', () => {
  it('keeps text, tool step summaries, file names and sources; drops reasoning, results and bytes', () => {
    const content = summarizeMessageParts([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'First' },
      { type: 'text', text: '  ' },
      { type: 'text', text: 'Second' },
      {
        type: 'dynamic-tool',
        toolName: 'mcp_lookup',
        toolCallId: 't1',
        state: 'output-error',
        input: {},
        errorText: 'boom',
      },
      {
        type: 'data-attachment',
        data: { id: 'a1', filename: 'f.pdf', mimeType: 'application/pdf', url: '/x' },
      },
      { type: 'data-attachment', data: { url: '/no-name' } },
      { type: 'file', filename: 'p.png', mediaType: 'image/png', url: 'data:image/png;base64,AA' },
      { type: 'file', url: 'data:,unnamed' },
      { type: 'source-url', url: 'https://example.test' },
      { type: 'source-url' },
      null,
      'junk',
    ]);
    expect(content.text).toBe('First\n\nSecond');
    expect(content.toolSteps).toEqual([
      {
        toolCallId: 't1',
        tool: 'mcp_lookup',
        state: expect.any(String),
        summary: expect.any(String),
      },
    ]);
    expect(content.files).toEqual([
      { attachmentId: 'a1', filename: 'f.pdf', mediaType: 'application/pdf' },
      { attachmentId: null, filename: 'p.png', mediaType: 'image/png' },
    ]);
    expect(content.sources).toEqual(['https://example.test']);
    expect(JSON.stringify(content)).not.toMatch(/thinking|base64|\/x"/);
    expect(summarizeMessageParts(undefined)).toEqual({
      text: '',
      toolSteps: [],
      files: [],
      sources: [],
    });
  });
});

describe('legal hold errors', () => {
  it('recognises the trigger’s error however it is wrapped', () => {
    expect(isLegalHoldViolation({ code: 'OCLH1' })).toBe(true);
    expect(isLegalHoldViolation(new Error('x', { cause: { code: 'OCLH1' } }))).toBe(true);
    expect(isLegalHoldViolation({ code: '23505' })).toBe(false);
    expect(isLegalHoldViolation(null)).toBe(false);
    expect(HELD_ACCOUNT_DELETION_MESSAGE).toMatch(/legal hold/);
  });
});
