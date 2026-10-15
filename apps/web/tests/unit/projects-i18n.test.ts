import { PROJECT_SHARE_ERROR_REASONS } from '@oci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteProjectText } from '../../src/components/projects/delete-project-text';
import { ApiError } from '../../src/lib/api-client';
import { reasonTexts } from '../../src/lib/classification';
import { describeAddResult, describeManagerError } from '../../src/lib/groups';
import { activateLocale, translate } from '../../src/lib/i18n';
import { accessLabel, describeShareError, sharedWithText } from '../../src/lib/project-access';

const refusal = (reason: string, status = 422, retry?: number) =>
  new ApiError(status, 'VALIDATION_FAILED', 'English server text', { reason }, retry);

describe('projects, sharing and groups in every language', () => {
  beforeEach(() => activateLocale('en'));
  afterEach(() => activateLocale('en'));

  it('names the three access levels the same way everywhere', async () => {
    await activateLocale('es');
    expect(['owner', 'editor', 'viewer'].map((a) => accessLabel(a as 'owner'))).toEqual([
      'Propietario',
      'Editor',
      'Lector',
    ]);
    await activateLocale('ar');
    expect(['owner', 'editor', 'viewer'].map((a) => accessLabel(a as 'owner'))).toEqual([
      'المالك',
      'محرّر',
      'مشاهد',
    ]);
  });

  it('says every sharing refusal reason as a sentence of its own, not the server’s English', async () => {
    for (const locale of ['es', 'ar'] as const) {
      await activateLocale(locale);
      for (const reason of PROJECT_SHARE_ERROR_REASONS) {
        const text = describeShareError(refusal(reason), 'fallback');
        expect(text, `${locale} ${reason}`).not.toBe('English server text');
        expect(text, `${locale} ${reason}`).not.toBe('fallback');
        expect(text, `${locale} ${reason}`).not.toMatch(/[{}]/);
      }
    }
  });

  it('puts the limit and the wait in the sentence, with the language’s plural', async () => {
    await activateLocale('es');
    expect(describeShareError(refusal('share_limit'), 'x')).toContain('50');
    expect(describeShareError(new ApiError(429, 'RATE_LIMITED', 'x', undefined, 1), 'x')).toContain(
      '1 segundo',
    );
    expect(
      describeShareError(new ApiError(429, 'RATE_LIMITED', 'x', undefined, 12), 'x'),
    ).toContain('12 segundos');
    await activateLocale('ar');
    // Arabic has a dual form for two.
    expect(describeShareError(new ApiError(429, 'RATE_LIMITED', 'x', undefined, 2), 'x')).toContain(
      'ثانيتين',
    );
  });

  it('counts people and groups with the plural of each language', async () => {
    expect(sharedWithText(1, 0)).toBe('1 person');
    expect(sharedWithText(2, 1)).toBe('2 people and 1 group');
    await activateLocale('es');
    expect(sharedWithText(2, 1)).toBe('2 personas y 1 grupo');
    await activateLocale('ar');
    expect(sharedWithText(2, 0)).toBe('شخصين');
  });

  it('words what deleting a project does by each count', async () => {
    await activateLocale('es');
    expect(deleteProjectText(0, 0)).toBe('No tiene conversaciones ni archivos.');
    expect(deleteProjectText(1, 3)).toContain('Su conversación se conserva');
    expect(deleteProjectText(1, 3)).toContain('Sus 3 archivos');
    await activateLocale('ar');
    expect(deleteProjectText(0, 1)).toContain('لا تحتوي على محادثات.');
  });

  it('keeps the privacy statement complete in every language', async () => {
    const english = translate('sharing.dialog.explanation');
    expect(english).toBe(
      "People you share with use this project's instructions and files in their own conversations, which stay private to them. Files they add count against their storage.",
    );
    for (const locale of ['es', 'ar'] as const) {
      await activateLocale(locale);
      const text = translate('sharing.dialog.explanation');
      expect(text).not.toBe(english);
      // Two sentences: what they use and that it stays private, and the storage.
      expect(text.split(/[.]/).filter(Boolean)).toHaveLength(2);
    }
  });

  it('maps a manager’s refusals by reason', async () => {
    await activateLocale('es');
    const limit = new ApiError(409, 'CONFLICT', 'x', {
      reason: 'person_group_limit',
      limit: 10,
      emails: ['a@x.test', 'b@x.test'],
    });
    expect(describeManagerError(limit, 'fallback')).toBe(
      'Una persona puede estar en 10 grupos como máximo. Ya están en 10: a@x.test y b@x.test. No se añadió a nadie.',
    );
    expect(describeManagerError(new ApiError(404, 'NOT_FOUND', 'x'), 'f')).toBe(
      'Ya no eres responsable de este grupo.',
    );
    expect(
      describeAddResult({
        added: ['a'],
        alreadyMembers: [],
        unknown: ['b'],
        memberCount: 4,
      } as never).summary,
    ).toBe('Se añadió 1 persona. El grupo tiene ahora 4 miembros.');
  });

  it('says why a data-class label is carried, with the connectors in a list', async () => {
    const entry = {
      id: 'c',
      name: 'Records',
      reasons: ['connector'],
      connectorNames: ['SIS', 'Docs'],
    };
    await activateLocale('es');
    expect(reasonTexts(entry as never, 'thread')).toEqual(['de los conectores SIS y Docs']);
  });
});
