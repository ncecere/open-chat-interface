// @vitest-environment happy-dom
import type { AdminClassification, AdminDataClass } from '@oci/shared';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODE_NOT_AVAILABLE_TEXT } from '../../src/components/admin/data-classes/mode-section';
import { ApiError } from '../../src/lib/api-client';
import { AdminDataClassesPage } from '../../src/routes/admin/data-classes';
import {
  alerts,
  button,
  cleanup,
  click,
  dialog,
  findButton,
  renderAdmin,
  typeInto,
  typeIntoTextarea,
} from './admin-test-utils';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  put: vi.fn(),
}));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));

function dataClass(overrides: Partial<AdminDataClass> = {}): AdminDataClass {
  return {
    id: 'c1',
    name: 'Student records',
    description: 'Anything about enrolled students.',
    retiredAt: null,
    modelCount: 2,
    connectorCount: 1,
    projectCount: 3,
    threadCount: 14,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

let root: Root | undefined;
let settings: AdminClassification;
let classes: AdminDataClass[];

beforeEach(() => {
  settings = {
    mode: 'off',
    services: { webSearch: [], embeddings: [], reranking: [] },
    modeAvailable: true,
    backfillDone: true,
    unreviewedConnectorCount: 0,
  };
  classes = [dataClass()];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/admin/classification') return settings;
    if (path === '/admin/data-classes') return { classes };
    throw new Error(`Unexpected GET ${path}`);
  });
  for (const method of [api.post, api.patch, api.delete, api.put])
    method.mockReset().mockResolvedValue({});
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

const render = async (role: 'admin' | 'auditor' = 'admin') => {
  ({ root } = await renderAdmin(<AdminDataClassesPage />, { role, path: '/admin/data-classes' }));
};
const text = () => document.body.textContent ?? '';
const radio = (mode: string) =>
  document.querySelector<HTMLInputElement>(`#classification-mode-${mode}`)!;
const rows = () => [...document.querySelectorAll('[data-testid="data-class"]')];

describe('Data classes page: mode', () => {
  it('offers Off, Warn and Block with a sentence each, and saves the one chosen', async () => {
    await render();
    expect(document.querySelector('h1')?.textContent).toBe('Data classes');
    expect(radio('off').checked).toBe(true);
    expect(text()).toContain('Nothing is checked and nothing changes for anyone.');
    expect(text()).toContain(
      'Nothing is refused: what Block would have refused goes ahead, with a notice, and is recorded in the audit log.',
    );
    expect(text()).toContain(
      'Anything that would carry a class to a model or service that is not approved for it is refused.',
    );
    // Nothing to save until it changes.
    expect(button('Save changes to the mode').getAttribute('aria-disabled') ?? '').not.toBe(
      'false',
    );
    await click(radio('warn'));
    await click(button('Save changes to the mode'));
    expect(api.patch).toHaveBeenCalledWith('/admin/classification', { mode: 'warn' });
  });

  it('says clearly that Warn and Block need the upgrade finished, when the API answers 409', async () => {
    api.patch.mockRejectedValue(
      new ApiError(409, 'CONFLICT', 'Warn and block cannot be turned on until …'),
    );
    await render();
    await click(radio('block'));
    await click(button('Save changes to the mode'));
    expect(alerts()).toContain(MODE_NOT_AVAILABLE_TEXT);
    expect(MODE_NOT_AVAILABLE_TEXT).toContain('migrate --post');
    // The choice stays on screen to try again; the saved mode is unchanged.
    expect(radio('block').checked).toBe(true);
  });

  it('shows another failure in the server’s words', async () => {
    api.patch.mockRejectedValue(
      new ApiError(500, 'INTERNAL_ERROR', 'The database is unavailable.'),
    );
    await render();
    await click(radio('warn'));
    await click(button('Save changes to the mode'));
    expect(alerts().join()).toContain('The database is unavailable.');
  });
});

describe('Data classes page: banners', () => {
  it('warns while the upgrade is unfinished that older servers check nothing', async () => {
    settings = { ...settings, modeAvailable: false, backfillDone: false };
    await render();
    const banner = alerts().find((entry) => entry.includes('not finished'));
    expect(banner).toContain('Servers still on v0.13 do not check data classification at all');
    expect(banner).toContain('migrate --post');
    expect(text()).not.toContain('Finding which conversations');
  });

  it('says a background migration is still running, once the upgrade has finished', async () => {
    settings = { ...settings, backfillDone: false };
    await render();
    expect(text()).toContain('Finding which conversations used connectors before 0.14');
    expect(text()).toContain('nothing is missed');
    expect(text()).not.toContain('The upgrade to 0.14 is not finished');
  });

  it('is quiet when all is done', async () => {
    await render();
    expect(text()).not.toContain('not finished');
    expect(text()).not.toContain('Finding which conversations');
    expect(text()).not.toContain('not reviewed');
  });

  it('counts connectors nobody has reviewed, only while it is on', async () => {
    settings = { ...settings, mode: 'warn', unreviewedConnectorCount: 2 };
    await render();
    expect(text()).toContain('2 connectors still have no statement of what they carry');
    await cleanup(root!);
    settings = { ...settings, unreviewedConnectorCount: 1 };
    await render();
    expect(text()).toContain('1 connector still has no statement of what it carries');
    await cleanup(root!);
    settings = { ...settings, mode: 'off' };
    await render();
    expect(text()).not.toContain('still has no statement');
  });
});

describe('Data classes page: the classes', () => {
  it('lists each with its description and where it is used', async () => {
    classes = [
      dataClass(),
      dataClass({
        id: 'c2',
        name: 'Health data',
        description: '',
        retiredAt: '2026-10-02T09:00:00.000Z',
        modelCount: 0,
        connectorCount: 0,
        projectCount: 0,
        threadCount: 0,
      }),
    ];
    await render();
    expect(rows().map((row) => row.querySelector('h3')?.textContent)).toEqual([
      'Student records',
      'Health data',
    ]);
    expect(rows()[0]?.textContent).toContain('Anything about enrolled students.');
    expect(rows()[0]?.textContent).toContain(
      'Approved for 2 models · carried by 1 connector · on 3 projects and 14 conversations',
    );
    expect(rows()[1]?.textContent).toContain('Retired');
    expect(rows()[1]?.textContent).toContain(
      'Approved for no models · carried by no connectors · on no projects and no conversations',
    );
    // A retired class cannot be retired again.
    expect(findButton('Retire Health data')).toBeUndefined();
    expect(findButton('Retire Student records')).toBeDefined();
  });

  it('adds a class', async () => {
    classes = [];
    await render();
    expect(text()).toContain('No data classes yet.');
    await click(button('Add data class'));
    await typeInto(document.querySelector<HTMLInputElement>('#data-class-name')!, 'Health data');
    await typeIntoTextarea(
      document.querySelector<HTMLTextAreaElement>('#data-class-description')!,
      'Clinical notes',
    );
    await click(dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!);
    expect(api.post).toHaveBeenCalledWith('/admin/data-classes', {
      name: 'Health data',
      description: 'Clinical notes',
    });
    expect(dialog()).toBeNull();
  });

  it('asks for a name, and shows the name already taken at the field', async () => {
    await render();
    await click(button('Add data class'));
    await click(dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!);
    expect(api.post).not.toHaveBeenCalled();
    expect(alerts(dialog()!)).toEqual(['Name: Give the class a name.']);
    await typeInto(
      document.querySelector<HTMLInputElement>('#data-class-name')!,
      'Student records',
    );
    api.post.mockRejectedValue(
      new ApiError(409, 'CONFLICT', 'A data class named Student records already exists.'),
    );
    await click(dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!);
    expect(alerts(dialog()!).join()).toContain('already exists');
    expect(dialog()).not.toBeNull();
  });

  it('renames a class, saying that labels and approvals follow', async () => {
    await render();
    await click(button('Rename Student records'));
    expect(dialog()?.textContent).toContain('labels and approvals stay with the class');
    const name = document.querySelector<HTMLInputElement>('#data-class-name')!;
    expect(name.value).toBe('Student records');
    await typeInto(name, 'Student data');
    await click(dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!);
    expect(api.patch).toHaveBeenCalledWith('/admin/data-classes/c1', {
      name: 'Student data',
      description: 'Anything about enrolled students.',
    });
  });

  it('closes a rename that changes nothing without a request', async () => {
    await render();
    await click(button('Rename Student records'));
    await click(dialog()!.querySelector<HTMLButtonElement>('button[type="submit"]')!);
    expect(api.patch).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('retires a class after saying what that does and does not do', async () => {
    await render();
    await click(button('Retire Student records'));
    expect(dialog()?.textContent).toContain('still counts');
    await click(button('Retire class'));
    expect(api.post).toHaveBeenCalledWith('/admin/data-classes/c1/retire');
  });

  it('explains by the counts why a class in use cannot be deleted, and holds the button back', async () => {
    await render();
    await click(button('Delete Student records'));
    expect(dialog()?.textContent).toContain(
      'Student records is still used by 1 connector, 3 projects and 14 conversations, so it cannot be deleted.',
    );
    expect(button('Delete class').disabled).toBe(true);
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('deletes a class nothing refers to', async () => {
    classes = [dataClass({ connectorCount: 0, projectCount: 0, threadCount: 0, modelCount: 1 })];
    await render();
    await click(button('Delete Student records'));
    expect(dialog()?.textContent).toContain(
      '1 model is approved for it, and that approval goes with it',
    );
    await click(button('Delete class'));
    expect(api.delete).toHaveBeenCalledWith('/admin/data-classes/c1');
  });

  it('explains a 409 from a label added since the page loaded, by its counts', async () => {
    classes = [dataClass({ connectorCount: 0, projectCount: 0, threadCount: 0 })];
    api.delete.mockRejectedValue(
      new ApiError(409, 'CONFLICT', 'This class is still used …', {
        connectors: 0,
        projects: 1,
        threads: 2,
      }),
    );
    await render();
    await click(button('Delete Student records'));
    await click(button('Delete class'));
    expect(alerts(dialog()!).join()).toContain(
      'Student records is still used by 1 project and 2 conversations, so it cannot be deleted.',
    );
    // The page's numbers are read again.
    expect(api.get).toHaveBeenCalledWith('/admin/data-classes');
  });
});

describe('Data classes page: other services', () => {
  it('starts with no class for each and saves what is chosen', async () => {
    await render();
    expect(text()).toContain(
      'No class: a conversation that carries any class does not use web search',
    );
    const webSearch = document.querySelector<HTMLFieldSetElement>('fieldset[aria-describedby]');
    expect(webSearch).not.toBeNull();
    const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    // One class, three services.
    expect(boxes).toHaveLength(3);
    await click(boxes[0]!);
    await click(boxes[2]!);
    await click(button('Save changes to the other services'));
    expect(api.patch).toHaveBeenCalledWith('/admin/classification', {
      services: { webSearch: ['c1'], embeddings: [], reranking: ['c1'] },
    });
  });

  it('shows a failure to save', async () => {
    api.patch.mockRejectedValue(
      new ApiError(422, 'VALIDATION_FAILED', 'One of those data classes does not exist.'),
    );
    await render();
    await click(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!);
    await click(button('Save changes to the other services'));
    expect(alerts().join()).toContain('does not exist');
  });

  it('points at the data classes to define when there are none', async () => {
    classes = [];
    await render();
    expect(text()).toContain('No data classes are defined yet.');
  });
});

describe('Data classes page: loading and failing', () => {
  it('says so when the settings cannot be loaded, and tries again', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/admin/classification') throw new ApiError(500, 'INTERNAL_ERROR', 'Down.');
      return { classes };
    });
    await render();
    expect(alerts()).toContain('Data classification settings could not be loaded.');
    await click(button('Try again'));
    // Only what failed is asked for again.
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it('says so when the classes cannot be loaded', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path === '/admin/data-classes') throw new ApiError(500, 'INTERNAL_ERROR', 'Down.');
      return settings;
    });
    await render();
    expect(alerts()).toContain('Data classes could not be loaded.');
  });
});

describe('Data classes page: an auditor', () => {
  it('can read everything and change nothing', async () => {
    settings = { ...settings, mode: 'block' };
    await render('auditor');
    expect(rows()).toHaveLength(1);
    expect(radio('block').checked).toBe(true);
    // Every control is disabled, and there is nothing to save or add.
    expect(radio('warn').closest('fieldset[disabled]')).not.toBeNull();
    expect(findButton('Add data class')).toBeUndefined();
    expect(findButton('Rename Student records')).toBeUndefined();
    expect(findButton('Retire Student records')).toBeUndefined();
    expect(findButton('Delete Student records')).toBeUndefined();
    expect(findButton('Save changes to the mode')).toBeUndefined();
    expect(
      [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(
        (box) => box.closest('fieldset[disabled]') !== null,
      ),
    ).toBe(true);
  });
});
