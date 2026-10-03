// @vitest-environment happy-dom
import { DatabaseBackup } from 'lucide-react';
import { act, useState } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DestinationDraft,
  DestinationSelect,
  type DestinationSettings,
  DestinationTest,
  destinationChanges,
  destinationDraftFrom,
  S3BucketFields,
} from '../../src/components/admin/operations/destination';
import {
  formatRunTime,
  type OperationRun,
  RunHistory,
  RunNowControl,
} from '../../src/components/admin/operations/runs';
import {
  formatHourUtc,
  HourField,
  IntervalField,
  RetentionField,
} from '../../src/components/admin/operations/schedule';
import { button, cleanup, click, findButton, renderAdmin, settle } from './admin-test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api-client')>()),
  api,
}));
// Radix Select needs layout APIs happy-dom lacks; a native select exercises
// the same value/onChange contract.
vi.mock('../../src/components/ui/select', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/components/ui/select')>()),
  Select: ({
    id,
    value,
    onChange,
    options,
  }: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: readonly { value: string; label: string }[];
  }) => (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const SETTINGS: DestinationSettings = {
  destination: 'separate',
  prefix: 'oci-backups/',
  s3: {
    bucket: 'archive',
    region: 'us-east-1',
    endpoint: null,
    accessKeyId: 'AKIA',
    forcePathStyle: false,
    hasCredential: true,
  },
};

let root: Root | undefined;
beforeEach(() => {
  api.get.mockReset().mockResolvedValue({});
  api.post.mockReset();
});
afterEach(async () => {
  if (root) await cleanup(root);
  root = undefined;
});

async function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    if (element instanceof HTMLSelectElement) {
      element.value = value;
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await settle();
}
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

describe('operations destination', () => {
  it('starts a draft from the saved settings, with no secret', () => {
    expect(destinationDraftFrom(SETTINGS)).toEqual({
      destination: 'separate',
      prefix: 'oci-backups/',
      bucket: 'archive',
      region: 'us-east-1',
      endpoint: '',
      accessKeyId: 'AKIA',
      forcePathStyle: false,
      secretAccessKey: '',
    });
  });

  it('sends only what changed, trimmed, and the secret only when typed', () => {
    const draft = destinationDraftFrom(SETTINGS);
    expect(destinationChanges(SETTINGS, draft)).toEqual({});
    expect(
      destinationChanges(SETTINGS, {
        ...draft,
        destination: 'storage',
        prefix: ' backups/ ',
        bucket: ' other ',
        region: 'eu-west-1',
        endpoint: ' https://minio.example ',
        accessKeyId: ' AKIB ',
        forcePathStyle: true,
        secretAccessKey: 'secret',
      }),
    ).toEqual({
      destination: 'storage',
      prefix: 'backups/',
      s3: {
        bucket: 'other',
        region: 'eu-west-1',
        endpoint: 'https://minio.example',
        accessKeyId: 'AKIB',
        forcePathStyle: true,
        secretAccessKey: 'secret',
      },
    });
    // Clearing the endpoint sends null; an unchanged empty endpoint sends nothing.
    const withEndpoint = { ...SETTINGS, s3: { ...SETTINGS.s3, endpoint: 'https://x' } };
    expect(destinationChanges(withEndpoint, { ...draft, endpoint: '  ' })).toEqual({
      s3: { endpoint: null },
    });
  });

  it('edits the separate bucket, and never shows the secret', async () => {
    const changes: Array<Partial<DestinationDraft>> = [];
    function Harness({ hasCredential }: { hasCredential: boolean }) {
      const [draft, setDraft] = useState(destinationDraftFrom(SETTINGS));
      return (
        <>
          <DestinationSelect
            idPrefix="ops"
            value={draft.destination}
            hint={draft.destination === 'storage' ? 'Attachment bucket.' : 'Own bucket.'}
            onChange={(destination) => setDraft((current) => ({ ...current, destination }))}
          />
          <S3BucketFields
            idPrefix="ops"
            draft={draft}
            hasCredential={hasCredential}
            prefixHint="Folder, ending with /."
            onChange={(change) => {
              changes.push(change);
              setDraft((current) => ({ ...current, ...change }));
            }}
          />
        </>
      );
    }
    ({ root } = await renderAdmin(<Harness hasCredential />));
    expect(byId<HTMLInputElement>('ops-bucket').value).toBe('archive');
    expect(byId<HTMLInputElement>('ops-secret').type).toBe('password');
    expect(byId<HTMLInputElement>('ops-secret').value).toBe('');
    expect(document.body.textContent).toContain('Set. Leave empty to keep it');
    expect(document.body.textContent).toContain('Own bucket.');
    expect(document.body.textContent).toContain('Folder, ending with /.');

    await setValue(byId('ops-bucket'), 'new-bucket');
    await setValue(byId('ops-region'), 'eu-west-1');
    await setValue(byId('ops-endpoint'), 'https://minio.example');
    await setValue(byId('ops-prefix'), 'x/');
    await setValue(byId('ops-access-key'), 'AKIB');
    await setValue(byId('ops-secret'), 'typed');
    await click(byId('ops-path-style'));
    expect(changes).toEqual([
      { bucket: 'new-bucket' },
      { region: 'eu-west-1' },
      { endpoint: 'https://minio.example' },
      { prefix: 'x/' },
      { accessKeyId: 'AKIB' },
      { secretAccessKey: 'typed' },
      { forcePathStyle: true },
    ]);

    await setValue(byId('ops-destination'), 'storage');
    expect(document.body.textContent).toContain('Attachment bucket.');

    await cleanup(root!);
    ({ root } = await renderAdmin(<Harness hasCredential={false} />));
    expect(document.body.textContent).toContain('Not set. Stored encrypted and never shown again.');
  });

  it('tests the saved destination, and asks to save changes first', async () => {
    api.post.mockResolvedValueOnce({ ok: true, detail: 'Wrote and read back a test object.' });
    ({ root } = await renderAdmin(<DestinationTest endpoint="/admin/x/test" hasChanges={false} />));
    await click(button('Test destination'));
    expect(api.post).toHaveBeenCalledWith('/admin/x/test');
    expect(document.body.textContent).toContain('Wrote and read back a test object.');

    api.post.mockResolvedValueOnce({ ok: false, detail: 'Access denied.' });
    await click(button('Test destination'));
    const failed = [...document.querySelectorAll('span')].find(
      (node) => node.textContent === 'Access denied.',
    );
    expect(failed?.className).toContain('--danger');

    await cleanup(root!);
    ({ root } = await renderAdmin(<DestinationTest endpoint="/admin/x/test" hasChanges />));
    expect(button('Test destination').disabled).toBe(true);
    expect(document.body.textContent).toContain('Save first to test these settings.');

    await cleanup(root!);
    api.post.mockRejectedValueOnce(new Error('offline'));
    ({ root } = await renderAdmin(<DestinationTest endpoint="/admin/x/test" hasChanges={false} />));
    await click(button('Test destination'));
    expect(document.body.textContent).toContain('The destination could not be tested.');
  });

  it('offers no test to a read-only viewer', async () => {
    ({ root } = await renderAdmin(<DestinationTest endpoint="/admin/x/test" hasChanges={false} />, {
      role: 'auditor',
    }));
    expect(findButton('Test destination')).toBeUndefined();
  });
});

describe('operations schedule', () => {
  it('formats hours in UTC', () => {
    expect(formatHourUtc(3)).toBe('03:00 UTC');
    expect(formatHourUtc(23)).toBe('23:00 UTC');
  });

  it('chooses an hour, an interval and a retention value', async () => {
    const onHour = vi.fn();
    const onInterval = vi.fn();
    const onKeep = vi.fn();
    ({ root } = await renderAdmin(
      <>
        <HourField id="ops-hour" hint="Starts near this hour." value={3} onChange={onHour} />
        <IntervalField
          id="ops-interval"
          value="daily"
          options={[
            { value: 'hourly', label: 'Every hour' },
            { value: 'daily', label: 'Once a day' },
          ]}
          onChange={onInterval}
        />
        <RetentionField
          id="ops-keep"
          label="Kept"
          hint="How many."
          min={1}
          max={90}
          placeholder="Keep"
          value="7"
          onChange={onKeep}
        />
      </>,
    ));
    const hour = byId<HTMLSelectElement>('ops-hour');
    expect(hour.options).toHaveLength(24);
    expect(hour.value).toBe('3');
    expect(hour.options[13]?.textContent).toBe('13:00 UTC');
    await setValue(hour, '13');
    expect(onHour).toHaveBeenCalledWith(13);

    await setValue(byId('ops-interval'), 'hourly');
    expect(onInterval).toHaveBeenCalledWith('hourly');

    const keep = byId<HTMLInputElement>('ops-keep');
    expect([keep.type, keep.min, keep.max, keep.placeholder]).toEqual([
      'number',
      '1',
      '90',
      'Keep',
    ]);
    await setValue(keep, '14');
    expect(onKeep).toHaveBeenCalledWith('14');
    expect(document.body.textContent).toContain('How often');
    expect(document.body.textContent).toContain('Time of day');
  });
});

describe('operations runs', () => {
  type Run = OperationRun & { bytes: number; key: string | null };
  const run = (overrides: Partial<Run>): Run => ({
    id: 'r1',
    trigger: 'schedule',
    status: 'succeeded',
    startedAt: '2026-10-02T03:00:00.000Z',
    errorMessage: null,
    bytes: 10,
    key: 'prefix/run/manifest.json',
    ...overrides,
  });

  it('lists runs with their status, trigger, summary or error and the object written', async () => {
    ({ root } = await renderAdmin(
      <RunHistory
        runs={[
          run({ id: 'ok', trigger: 'manual' }),
          run({ id: 'bad', status: 'failed', errorMessage: 'Access denied', key: null }),
          run({ id: 'now', status: 'running', key: null }),
          run({ id: 'unknown', status: 'failed', key: null }),
        ]}
        testId="ops-run"
        empty={{ icon: DatabaseBackup, title: 'Nothing yet.', body: 'Run one.' }}
        badges={(item) => (item.status === 'succeeded' ? <span>Verified</span> : null)}
        summary={(item) => `${item.bytes} bytes`}
        details={(item) => (item.id === 'ok' ? <p data-testid="ops-detail">More</p> : null)}
        objectKey={(item) => item.key}
      />,
    ));
    const rows = [...document.querySelectorAll('[data-testid="ops-run"]')];
    expect(rows).toHaveLength(4);
    expect(
      rows.map((row) => row.querySelector('[role="img"]')?.getAttribute('aria-label')),
    ).toEqual(['Succeeded', 'Failed', 'Running', 'Failed']);
    expect(rows[0]?.textContent).toContain('Manual');
    expect(rows[0]?.textContent).toContain('Verified');
    expect(rows[0]?.textContent).toContain('10 bytes');
    expect(rows[0]?.textContent).toContain('prefix/run/manifest.json');
    expect(rows[0]?.querySelector('[data-testid="ops-detail"]')).not.toBeNull();
    expect(rows[1]?.textContent).toContain('Scheduled');
    expect(rows[1]?.textContent).toContain('Access denied');
    expect(rows[2]?.textContent).toContain('Running…');
    expect(rows[3]?.textContent).toContain('Failed');
    expect(rows[0]?.textContent).toContain(formatRunTime('2026-10-02T03:00:00.000Z'));
    expect(formatRunTime(null)).toBe('—');
  });

  it('shows an empty state before the first run', async () => {
    ({ root } = await renderAdmin(
      <RunHistory
        runs={[] as Run[]}
        testId="ops-run"
        empty={{ icon: DatabaseBackup, title: 'Nothing yet.', body: 'Run one.' }}
        badges={() => null}
        summary={() => ''}
        objectKey={() => null}
      />,
    ));
    expect(document.body.textContent).toContain('Nothing yet.');
    expect(document.body.textContent).toContain('Run one.');
  });

  it('starts a run now, and not while one runs or the job cannot run', async () => {
    const props = {
      endpoint: '/admin/x/run',
      queryKey: ['admin', 'x'],
      label: 'Run now',
      runningText: 'A run is in progress.',
      startedText: 'Run started.',
      errorMessage: 'The run could not be started.',
    };
    api.post.mockResolvedValueOnce({ started: true });
    ({ root } = await renderAdmin(<RunNowControl {...props} running={false} blocked={false} />));
    await click(button('Run now'));
    expect(api.post).toHaveBeenCalledWith('/admin/x/run');
    expect(document.body.textContent).toContain('Run started.');

    api.post.mockRejectedValueOnce(new Error('offline'));
    await click(button('Run now'));
    expect(document.body.textContent).toContain('The run could not be started.');

    await cleanup(root!);
    ({ root } = await renderAdmin(<RunNowControl {...props} running blocked={false} />));
    expect(button('Run now').disabled).toBe(true);
    expect(document.body.textContent).toContain('A run is in progress.');

    await cleanup(root!);
    ({ root } = await renderAdmin(<RunNowControl {...props} running={false} blocked />));
    expect(button('Run now').disabled).toBe(true);
  });
});
