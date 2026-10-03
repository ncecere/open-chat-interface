import {
  COLOR_THEMES,
  DEFAULT_APP_NAME,
  DIAGRAM_ACCENTS,
  diagramAccent,
  instanceName,
  updateInstanceSettingsSchema,
} from '@oci/shared';
import { getDocumentProxy } from 'unpdf';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipText } from '../../../test/xml.js';

/**
 * Branding applied everywhere (v0.10): what the API writes for people follows
 * Branding, and diagrams follow the colour theme rather than a hex accent the
 * Branding page cannot set.
 */

const settings = vi.hoisted(() => ({
  branding: { appName: 'Acme AI' } as Record<string, unknown> | undefined,
  fail: false,
}));
vi.mock('../../services/settings.js', () => ({
  getSetting: async (key: string) => {
    if (settings.fail) throw new Error('Injected settings failure');
    return key === 'branding' ? settings.branding : {};
  },
}));

const { currentAppName } = await import('../../services/branding.js');
const { fromHeader } = await import('../../services/email.js');
const { diagramGuidance } = await import('../../services/artifacts/guidance.js');
const { documentModel } = await import('../../services/documents/model.js');
const { renderDocx } = await import('../../services/documents/docx.js');
const { renderPdf } = await import('../../services/documents/pdf.js');
const { renderPptx } = await import('../../services/documents/pptx.js');
const { renderXlsx } = await import('../../services/documents/xlsx.js');
const { renderInWorker } = await import('../../services/documents/render.js');

beforeEach(() => {
  settings.branding = { appName: 'Acme AI' };
  settings.fail = false;
});

describe('diagram accent', () => {
  it('follows the colour theme', () => {
    expect(diagramAccent({ colorTheme: 'blue', accentColor: null })).toBe('#155dfc');
    expect(diagramAccent({ colorTheme: 'violet' })).toBe('#7f22fe');
    expect(diagramAccent({ colorTheme: 'emerald' })).toBe('#007a55');
  });

  it("keeps Diagram Design's orange for neutral, an unknown theme and none", () => {
    expect(diagramAccent({ colorTheme: 'neutral' })).toBe('#eb6c36');
    expect(diagramAccent({ colorTheme: 'teal' })).toBe('#eb6c36');
    expect(diagramAccent({})).toBe('#eb6c36');
  });

  it('has an accent for every theme, each a hex colour', () => {
    for (const theme of COLOR_THEMES) expect(DIAGRAM_ACCENTS[theme]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('lets an accentColor set through the API override the theme', () => {
    expect(diagramAccent({ colorTheme: 'blue', accentColor: '#3366FF' })).toBe('#3366FF');
    expect(diagramAccent({ colorTheme: 'blue', accentColor: '#abc' })).toBe('#abc');
  });

  it('ignores an accentColor that is not a hex colour', () => {
    for (const bad of ['blue', '#12', '#12345', 'url(x)', '#3366ff;fill:red', ''])
      expect(diagramAccent({ colorTheme: 'violet', accentColor: bad })).toBe('#7f22fe');
  });

  it('writes the accent into the diagram guidance', () => {
    expect(diagramGuidance(diagramAccent({ colorTheme: 'emerald' }))).toContain(
      'Use the accent #007a55',
    );
  });
});

describe('accentColor in a settings update', () => {
  it('accepts a hex colour or null', () => {
    expect(updateInstanceSettingsSchema.parse({ accentColor: ' #3366ff ' }).accentColor).toBe(
      '#3366ff',
    );
    expect(updateInstanceSettingsSchema.parse({ accentColor: null }).accentColor).toBeNull();
    expect(updateInstanceSettingsSchema.parse({}).accentColor).toBeUndefined();
  });

  it('rejects anything else', () => {
    for (const bad of ['blue', '#12', 'rgb(1,2,3)', '#3366ff;x'])
      expect(updateInstanceSettingsSchema.safeParse({ accentColor: bad }).success).toBe(false);
  });
});

describe('instance name', () => {
  it('is the configured name, trimmed, or the product name', () => {
    expect(instanceName(' Acme AI ')).toBe('Acme AI');
    expect(instanceName('   ')).toBe(DEFAULT_APP_NAME);
    expect(instanceName(null)).toBe('Open Chat Interface');
  });

  it('is read from Branding', async () => {
    expect(await currentAppName()).toBe('Acme AI');
  });

  it('falls back to the product name when Branding is blank or unreadable', async () => {
    settings.branding = { appName: '' };
    expect(await currentAppName()).toBe(DEFAULT_APP_NAME);
    settings.branding = undefined;
    expect(await currentAppName()).toBe(DEFAULT_APP_NAME);
    settings.fail = true;
    expect(await currentAppName()).toBe(DEFAULT_APP_NAME);
  });
});

describe('email sender', () => {
  it('gives a bare address the instance name', () => {
    expect(fromHeader(' no-reply@acme.test ', 'Acme AI')).toEqual({
      name: 'Acme AI',
      address: 'no-reply@acme.test',
    });
  });

  it('keeps a display name the administrator configured', () => {
    expect(fromHeader('Help Desk <help@acme.test>', 'Acme AI')).toBe('Help Desk <help@acme.test>');
  });
});

describe('document metadata', () => {
  const TABLE = '# Plan\n\n| a | b |\n| - | - |\n| 1 | 2 |';

  it('names the product when no instance name is given', () => {
    expect(documentModel('T', 'x').creator).toBe(DEFAULT_APP_NAME);
    expect(documentModel('T', 'x', '  ').creator).toBe(DEFAULT_APP_NAME);
  });

  it('names the instance as author in DOCX, PPTX and XLSX', async () => {
    const model = documentModel('Plan', TABLE, 'Acme <AI> & Co');
    for (const bytes of [await renderDocx(model), await renderPptx(model), renderXlsx(model)]) {
      const core = unzipText(bytes)['docProps/core.xml'];
      expect(core).toContain('Acme &lt;AI&gt; &amp; Co');
      expect(core).not.toContain('Open Chat Interface');
    }
  });

  it('names the instance as the PDF creator', async () => {
    const bytes = await renderPdf(documentModel('Plan', TABLE, 'Acme AI'), 5_000_000);
    const pdf = await getDocumentProxy(bytes);
    const { info } = (await pdf.getMetadata()) as unknown as { info: Record<string, unknown> };
    expect(info.Creator).toBe('Acme AI');
  });

  it('carries the instance name through the worker thread', async () => {
    const bytes = await renderInWorker('docx', 'Plan', TABLE, undefined, 'Acme AI');
    expect(unzipText(bytes)['docProps/core.xml']).toContain('Acme AI');
  });
});
