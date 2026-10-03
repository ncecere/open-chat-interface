import { describe, expect, it, vi } from 'vitest';
import { documentModel } from '../../services/documents/model.js';
import { renderPdf } from '../../services/documents/pdf.js';
import { inspectPdf } from './pdf-inspect.js';

// As if the optional font packages were not installed.
vi.mock('../../services/documents/pdf-font-faces.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/documents/pdf-font-faces.js')>()),
  PDF_FONT_FACES: [],
}));

describe('PDF export without the font packages', () => {
  it('falls back to the standard fonts, as before v0.10', async () => {
    const bytes = await renderPdf(documentModel('Привет', 'Привет, мир. Café.'), 20e6);
    const inspection = inspectPdf(bytes);
    expect(inspection.embedded).toEqual([]);
    expect(inspection.standard).toEqual(expect.arrayContaining(['Helvetica', 'Helvetica-Bold']));
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('/FontFile');
  });
});
