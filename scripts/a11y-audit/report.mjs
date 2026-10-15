#!/usr/bin/env node
/**
 * Generates docs/accessibility/acr.md, the accessibility conformance report in the VPAT 2.5
 * layout, from docs/accessibility/evidence.json (what `pnpm a11y:audit` measured) and
 * docs/accessibility/inspections.md (what a person inspected and wrote down).
 *
 * A row is never written by hand in the report: a measured row comes from the evidence, an
 * inspected row from inspections.md and is marked as an inspection, and a row with neither is
 * "Not Evaluated". The Revised Section 508 and EN 301 549 tables are derived row by row from
 * the WCAG rows (lib/mappings.mjs says how). `scripts/a11y-audit-docs.test.mjs` fails when the
 * committed report is not what this script produces from the committed inputs.
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADDED_IN,
  combine,
  DECISIVE,
  FPC_508,
  FPS_EN,
  HARDWARE_508,
  PARTIAL_EVIDENCE,
  STATUSES,
} from './lib/mappings.mjs';
import { REPO_ROOT } from './lib/routes.mjs';
import { CRITERIA, compareCriteria } from './lib/wcag.mjs';

export const DRAFT_BANNER = 'DRAFT: generated from a run against an unfinished build';

/**
 * inspections.md holds one block per inspected criterion:
 *
 *   ### 1.2.1
 *   - Status: Not Applicable
 *   - Method: what was looked at, and how
 *   - Remarks: what the reader should know
 *   - Date: 2026-10-15
 */
export function parseInspections(markdown) {
  const found = {};
  // An example in a code fence is documentation, not an inspection.
  const blocks = markdown
    .replace(/^```[\s\S]*?^```/gm, '')
    .split(/^### /m)
    .slice(1);
  for (const block of blocks) {
    const [heading, ...rest] = block.split('\n');
    const id = heading.trim();
    if (!/^\d\.\d\.\d+$/.test(id)) continue;
    const fields = {};
    let current = null;
    for (const line of rest) {
      const field = /^- (Status|Method|Remarks|Date): ?(.*)$/.exec(line);
      if (field) {
        current = field[1].toLowerCase();
        fields[current] = field[2].trim();
      } else if (current && /^\s+\S/.test(line)) fields[current] += ` ${line.trim()}`;
      else if (line.trim() === '') current = null;
    }
    if (!STATUSES.includes(fields.status)) {
      throw new Error(
        `inspections.md: ${id} has status "${fields.status}", expected one of ${STATUSES.join(', ')}`,
      );
    }
    if (!fields.method || !fields.remarks || !fields.date) {
      throw new Error(`inspections.md: ${id} needs a Method, Remarks and Date`);
    }
    if (found[id]) throw new Error(`inspections.md: ${id} appears twice`);
    found[id] = fields;
  }
  return found;
}

/** The first few finding ids, then how many more: a criterion can have a hundred. */
function listIds(list, shown = 5) {
  const ids = list
    .slice(0, shown)
    .map((finding) => finding.id)
    .join(', ');
  return list.length > shown ? `${ids} and ${list.length - shown} more` : ids;
}

const cell = (text) =>
  String(text)
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One WCAG row: status, where it came from, and the remark. */
export function deriveRow(id, evidence, inspections) {
  const entry = evidence.criteria?.[id];
  const own = (evidence.findings ?? []).filter((finding) => finding.criteria.includes(id));
  const failures = own.filter((finding) => finding.severity !== 'review');
  const reviews = own.filter((finding) => finding.severity === 'review');
  const decisive = DECISIVE[id];
  const ran = Boolean(
    decisive && entry && decisive.checks.every((check) => entry.checks.includes(check)),
  );
  const inspection = inspections[id];
  const routes = entry ? Object.entries(entry.routes) : [];
  const failingRoutes = routes.filter(([, counts]) => counts.failures > 0).length;

  let measured = null;
  if (failures.length > 0) {
    measured =
      routes.length >= 2 && failingRoutes === routes.length
        ? 'Does Not Support'
        : 'Partially Supports';
  } else if (decisive && ran) measured = 'Supports';

  let status;
  let source;
  if (measured && inspection) {
    status = combine([measured, inspection.status]);
    source = 'Measured and inspection';
  } else if (measured) {
    status = measured;
    source = 'Measured';
  } else if (inspection) {
    status = inspection.status;
    source = 'Inspection';
  } else {
    status = 'Not Evaluated';
    source = 'Not evaluated';
  }

  const parts = [`${source}.`];
  if (entry && entry.samples > 0) {
    const where = routes.length ? ` on ${plural(routes.length, 'route')}` : '';
    parts.push(
      `${plural(entry.samples, 'sample')}${where}: ${plural(failures.length, 'finding')}${failures.length ? ` (${listIds(failures)})` : ''}.`,
    );
  }
  for (const finding of failures.slice(0, 3)) {
    parts.push(
      `${finding.id} [${finding.severity}] ${finding.route}: ${finding.message}${finding.occurrences > 1 ? ` (${finding.occurrences} times in ${plural(finding.contextCount, 'context')})` : ''}.`,
    );
  }
  if (failures.length > 3) parts.push(`${failures.length - 3} more in findings.md.`);
  if (reviews.length > 0)
    parts.push(`${plural(reviews.length, 'item')} to review by a person (${listIds(reviews)}).`);
  if (decisive && ran && failures.length === 0) {
    parts.push(`No failures in: ${decisive.scope}.`);
    if (routes.length > 0 && routes.length <= 10) {
      parts.push(`Routes: ${routes.map(([route]) => route).join(', ')}.`);
    }
    if (id === '1.4.3') {
      const counters = evidence.checks?.contrast?.counters ?? {};
      const notJudged = Object.entries(counters)
        .filter(([name]) => name.startsWith('not-judged'))
        .reduce((sum, [, count]) => sum + count, 0);
      parts.push(
        `${counters.elements ?? 0} text elements were measured, ${notJudged} could not be judged.`,
      );
    }
  } else if (decisive && !ran)
    parts.push(
      `The checks that test this (${decisive.checks.join(', ')}) did not all run in this audit.`,
    );
  else if (PARTIAL_EVIDENCE[id] && entry) {
    parts.push(
      `Automation covers only part of this criterion: ${PARTIAL_EVIDENCE[id]}.${status === 'Not Evaluated' ? ' Not enough to evaluate it; an inspection is needed.' : ''}`,
    );
  } else if (!inspection && !entry)
    parts.push('Neither a measurement nor an inspection covers this criterion.');
  if (inspection)
    parts.push(
      `Inspection (${inspection.date}): ${inspection.remarks} Method: ${inspection.method}`,
    );
  if (entry) parts.push(`Evidence: evidence.json, criteria["${id}"].`);
  return { id, status, source, remarks: parts.join(' ') };
}

function table(rows, headers) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  return lines.join('\n');
}

const label = (criterion) => `${criterion.id} ${criterion.name}`;

function summarise(rows) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

function derived(statusById, ids) {
  const known = ids.filter((id) => statusById.has(id));
  const status = combine(known.map((id) => statusById.get(id)));
  const parts = known.map((id) => `${id} ${statusById.get(id)}`);
  return {
    status,
    remarks: known.length
      ? `Derived from WCAG ${parts.join('; ')}.`
      : 'No WCAG criterion maps to this requirement; not assessed.',
  };
}

/**
 * @param {{ evidence: object, inspections: object, version: string, draft: boolean, contact: string }} input
 */
export function renderReport({ evidence, inspections, version, draft, contact }) {
  const rows = CRITERIA.map((criterion) => ({
    criterion,
    ...deriveRow(criterion.id, evidence, inspections),
  }));
  const statusById = new Map(rows.map((row) => [row.id, row.status]));
  const a = rows.filter((row) => row.criterion.level === 'A');
  const aa = rows.filter((row) => row.criterion.level === 'AA');
  const date = evidence.generatedAt.slice(0, 10);
  const tool = evidence.tool;
  const matrix = evidence.matrix;
  const out = [];

  out.push('# Open Chat Interface: Accessibility Conformance Report (VPAT 2.5)');
  out.push('');
  if (draft) {
    out.push(
      `> **${DRAFT_BANNER}.** The rows below describe that run, not a release. Rows with no evidence say Not Evaluated.`,
    );
    out.push('');
  }
  out.push(
    '> **This is a self-assessment by the Open Chat Interface project. It is not an audit by a third party.** It says how it was made and what was not done. Where a contract needs independent assurance, commission an independent audit.',
  );
  out.push('');
  out.push(
    'This file is generated by `scripts/a11y-audit/report.mjs` from `evidence.json` (measured rows) and `inspections.md` (hand-written rows, marked Inspection). Do not edit it by hand; see [how to run the audit](../dev/accessibility-audit.md).',
  );
  out.push('');
  out.push('## Product');
  out.push('');
  out.push(
    table(
      [
        ['Name of product', 'Open Chat Interface (OCI)'],
        [
          'Description',
          'A self-hostable multi-model chat application: people chat with models, use projects, files, artifacts and connectors; administrators run the instance. A web application (React single-page app and an API).',
        ],
        ['Report version', `Open Chat Interface ${version}${draft ? ' (unreleased)' : ''}`],
        [
          'Build audited',
          evidence.app?.version
            ? `version file ${evidence.app.version}${evidence.app.commit ? `, commit ${evidence.app.commit.slice(0, 12)}` : ''}`
            : 'not recorded',
        ],
        ['Report date', date],
        ['Contact', contact],
        [
          'Evaluation methods used',
          'Automated, keyboard-walkthrough, accessibility-tree and measured checks, and inspections. See below.',
        ],
      ],
      ['Item', 'Detail'],
    ),
  );
  out.push('');
  out.push('## Applicable standards and guidelines');
  out.push('');
  out.push(
    table(
      [
        [
          'Web Content Accessibility Guidelines 2.2',
          'Level A and AA (includes every 2.0 and 2.1 criterion)',
          'Evaluated as the tables below say',
        ],
        ['Web Content Accessibility Guidelines 2.2', 'Level AAA', 'Not Evaluated'],
        [
          'Revised Section 508 standards (2017)',
          'Chapters 3 to 6; web content through WCAG 2.0 A and AA',
          'Derived from the WCAG rows',
        ],
        [
          'EN 301 549 V3.2.1',
          'Clauses 4, 5, 9 to 12; clause 9 is WCAG 2.1 A and AA',
          'Derived from the WCAG rows',
        ],
      ],
      ['Standard', 'Scope', 'How reported'],
    ),
  );
  out.push('');
  out.push('## Terms');
  out.push('');
  out.push(
    '- **Supports**: the functionality of the product has at least one method that meets the criterion without known defects, or meets it with equivalent facilitation. Written only where the evidence in the remarks supports it.',
  );
  out.push(
    '- **Partially Supports**: some functionality of the product does not meet the criterion. Written when a measurement or an inspection found a failure; the finding is cited and in [findings.md](findings.md).',
  );
  out.push(
    '- **Does Not Support**: the majority of the functionality does not meet the criterion (here: every route sampled failed it).',
  );
  out.push(
    '- **Not Applicable**: the criterion is not relevant to the product. Written only from an inspection that says why.',
  );
  out.push(
    '- **Not Evaluated**: not evaluated. This is the status of every criterion that neither a measurement that decides it nor an inspection covers. Passing automated checks that only test part of a criterion do not turn it into "Supports".',
  );
  out.push(
    '- **Measured** in a remark: produced by `pnpm a11y:audit`, cited by key into `evidence.json`. **Inspection**: a person looked and wrote it down in `inspections.md`.',
  );
  out.push('');
  out.push('## Evaluation methods used');
  out.push('');
  out.push(
    `Run on ${date} with ${tool.name} (Playwright ${tool['@playwright/test']}, ${tool.browser}, axe-core ${tool['axe-core']} through @axe-core/playwright ${tool['@axe-core/playwright']}), against a seeded instance, as fresh administrator, user and restricted accounts and signed out.`,
  );
  out.push('');
  const ran = (matrix.ran ?? []).map((key) => key.split('/'));
  const distinct = (index, fallback) =>
    ran.length ? [...new Set(ran.map((parts) => parts[index]))] : fallback;
  const viewName = (view) =>
    ({
      1280: '1280 px',
      768: '768 px',
      320: '320 px',
      zoom400: '400% zoom (320 by 256 px at scale 4)',
      text200: 'text at 200%',
      reduce: 'reduced motion',
    })[view] ?? view;
  out.push(
    table(
      [
        [
          'Matrix profile',
          `${matrix.profile} (${matrix.contexts} contexts of role, theme, accent, view and language)`,
        ],
        ['Roles', distinct(0, matrix.roles).join(', ')],
        ['Themes', distinct(1, matrix.themes).join(', ')],
        ['Accents', distinct(2, matrix.accents).join(', ')],
        ['Views', distinct(3, matrix.views).map(viewName).join(', ')],
        ['Languages', distinct(4, matrix.languages).join(', ')],
        [
          'Routes',
          `${evidence.routes.listed} listed in scripts/a11y-audit/routes.json (from router.tsx)`,
        ],
        ['Run time', `${evidence.durationSeconds} s`],
      ],
      ['Dimension', 'This run'],
    ),
  );
  out.push('');
  if (ran.length) {
    out.push(
      'The contexts that ran, as theme / accent / view / language, by role (a profile is a bounded subset of the full combination, so a combination that is not listed was not tested):',
    );
    out.push('');
    const byRole = new Map();
    for (const [role, ...rest] of ran) {
      byRole.set(role, [...(byRole.get(role) ?? []), rest.join(' / ')]);
    }
    out.push(
      table(
        [...byRole].map(([role, list]) => [role, list.join('; ')]),
        ['Role', 'Contexts'],
      ),
    );
    out.push('');
  }
  out.push('The methods, from the specification of the report:');
  out.push('');
  out.push(
    '1. **Automated**: axe-core over every route an end user and an administrator can reach, in the contexts above.',
  );
  out.push(
    '2. **Keyboard**: scripted walkthroughs with `page.keyboard` only: sign in with and without two-step verification, start a chat, send, stop, approve a tool, open an artifact, search, rename, share, add a project file, change a setting, an administrator task. Recorded per task: completion, tab presses, visible focus (2.4.7), focus not obscured (2.4.11), traps (2.1.2), character-key shortcuts (2.1.4), the skip link (2.4.1).',
  );
  out.push(
    "3. **Accessibility tree**: Chromium's `Accessibility.getFullAXTree` for names and states of controls; landmarks, headings, form labels, error association, autocomplete tokens (1.3.5); live regions observed while a reply streamed, failed and stopped (4.1.3).",
  );
  out.push(
    '4. **Measured**: contrast of every text colour pair as rendered (1.4.3), edges of fields and icons (1.4.11), target size (2.5.8), the 1.4.12 text-spacing override, reflow at 320 px and 400% zoom (1.4.10), text at 200% (1.4.4), orientation (1.3.4), reduced motion.',
  );
  out.push(
    '5. **WCAG 2.2 additions** by name: 2.4.11, 2.5.7 (the artifact panel resize handle is a keyboard-operable separator), 2.5.8, 3.2.6, 3.3.7, 3.3.8.',
  );
  out.push('');
  out.push(
    'Every automated check was first shown to be able to fail, against a fixture with a known defect (`scripts/a11y-audit/fixtures/broken.html`, `apps/web/tests/e2e/accessibility-audit-controls.spec.ts`).',
  );
  out.push('');
  const checkLines = Object.entries(evidence.checks).map(([name, entry]) => [
    name,
    entry.samples,
    entry.occurrences,
    entry.limits.join(' '),
  ]);
  out.push(table(checkLines, ['Check', 'Samples', 'Failures and reviews', 'What it cannot see']));
  out.push('');
  if (evidence.skipped?.length) {
    out.push('**Not run in this audit:**');
    out.push('');
    for (const item of evidence.skipped) out.push(`- ${item.what}: ${item.reason}`);
    out.push('');
  }
  if (evidence.errorCount) {
    out.push(
      `**Harness errors:** ${evidence.errorCount} (a page that did not open, a check that threw). Each is listed in \`evidence.json\` under \`errors\`; none is counted as a pass.`,
    );
    out.push('');
  }
  out.push('## Known limitations');
  out.push('');
  out.push(
    '- **No person used a screen reader or voice control on it.** No one drove JAWS, NVDA, VoiceOver or TalkBack, or Dragon or Voice Control. The accessibility tree is read as Chromium computes it, which shows that a name, role and state exist, not that a screen reader says anything helpful.',
  );
  out.push(
    '- **No independent evaluator.** The people who built the product made this assessment.',
  );
  out.push(
    '- **User-generated and model-generated content** (Markdown, HTML artifacts, SVG diagrams, code) is only as accessible as its author or the model makes it. The product renders it; it cannot make it conformant.',
  );
  out.push(
    '- **Administrator-uploaded logos and documents**, and any third-party documents a person attaches, are not assessed.',
  );
  out.push(
    '- Pages were opened in an instance with no working model provider; replies, tool approvals and artifacts were exercised against a stand-in that sends the same events. Real model output was not tested.',
  );
  out.push('- Only Chromium was used. Other browsers and assistive technologies may differ.');
  out.push('- The matrix above is what ran; combinations outside it were not tested.');
  out.push(
    '- Text over images and gradients cannot be measured for contrast, and is counted rather than judged.',
  );
  out.push('');
  out.push(
    `## WCAG 2.2 Report: Table 1: Success Criteria, Level A (${Object.entries(summarise(a))
      .filter(([, n]) => n)
      .map(([s, n]) => `${n} ${s}`)
      .join(', ')})`,
  );
  out.push('');
  out.push(
    table(
      a.map((row) => [label(row.criterion), row.status, row.remarks]),
      ['Criteria', 'Conformance level', 'Remarks and explanations'],
    ),
  );
  out.push('');
  out.push(
    `## WCAG 2.2 Report: Table 2: Success Criteria, Level AA (${Object.entries(summarise(aa))
      .filter(([, n]) => n)
      .map(([s, n]) => `${n} ${s}`)
      .join(', ')})`,
  );
  out.push('');
  out.push(
    table(
      aa.map((row) => [label(row.criterion), row.status, row.remarks]),
      ['Criteria', 'Conformance level', 'Remarks and explanations'],
    ),
  );
  out.push('');
  out.push('## WCAG 2.2 Report: Table 3: Success Criteria, Level AAA');
  out.push('');
  out.push(
    table(
      [
        [
          'All level AAA criteria',
          'Not Evaluated',
          'Level AAA was not evaluated. 1.4.6 Contrast (Enhanced), 2.3.3 Animation from Interactions and 2.4.13 Focus Appearance are looked at as a by-product of other checks, but no AAA conformance is claimed.',
        ],
      ],
      ['Criteria', 'Conformance level', 'Remarks and explanations'],
    ),
  );
  out.push('');
  out.push(
    '4.1.1 Parsing was removed from WCAG 2.2. It is part of WCAG 2.0 and 2.1, which the Revised Section 508 and EN 301 549 still cite, and is "Not Evaluated" in the derived tables below because this audit has no test for it.',
  );
  out.push('');

  // Revised Section 508, derived.
  const old = rows.filter((row) => !ADDED_IN[row.id]);
  const parsing = {
    criterion: { id: '4.1.1', name: 'Parsing' },
    status: 'Not Evaluated',
    remarks: 'Not evaluated: removed from WCAG 2.2, so this audit has no test for it.',
  };
  out.push('## Revised Section 508 Report');
  out.push('');
  out.push(
    'Each row is derived from the WCAG rows above (the criteria added in WCAG 2.1 and 2.2 are not part of the Revised Section 508, which cites WCAG 2.0). Where nothing maps to a requirement it is "Not Evaluated", not "Supports".',
  );
  out.push('');
  const oldA = [...old.filter((row) => row.criterion.level === 'A'), parsing].sort((x, y) =>
    compareCriteria(x.criterion.id, y.criterion.id),
  );
  const oldAA = old.filter((row) => row.criterion.level === 'AA');
  out.push('### Table 1: Success Criteria, Level A (WCAG 2.0)');
  out.push('');
  out.push(
    table(
      oldA.map((row) => [
        label(row.criterion),
        row.status,
        row.id ? `Derived from the WCAG 2.2 row ${row.id}.` : row.remarks,
      ]),
      ['Criteria', 'Conformance level', 'Remarks and explanations'],
    ),
  );
  out.push('');
  out.push('### Table 2: Success Criteria, Level AA (WCAG 2.0)');
  out.push('');
  out.push(
    table(
      oldAA.map((row) => [
        label(row.criterion),
        row.status,
        `Derived from the WCAG 2.2 row ${row.id}.`,
      ]),
      ['Criteria', 'Conformance level', 'Remarks and explanations'],
    ),
  );
  out.push('');
  out.push('### Chapter 3: Functional Performance Criteria');
  out.push('');
  const fpcStatus = new Map();
  const fpcRows = FPC_508.map(([id, name, ids]) => {
    const result = derived(statusById, ids);
    fpcStatus.set(id, result.status);
    return [`${id} ${name}`, result.status, result.remarks];
  });
  out.push(table(fpcRows, ['Criteria', 'Conformance level', 'Remarks and explanations']));
  out.push('');
  out.push('### Chapter 4: Hardware');
  out.push('');
  out.push(
    table(
      [
        [
          '401 to 415 Hardware',
          'Not Applicable',
          `${HARDWARE_508} This is a scope statement, not a finding.`,
        ],
      ],
      ['Criteria', 'Conformance level', 'Remarks and explanations'],
    ),
  );
  out.push('');
  out.push('### Chapter 5: Software');
  out.push('');
  const allOld = derived(
    new Map(old.map((row) => [row.id, row.status])),
    old.map((row) => row.id),
  );
  const accessibilityServices = derived(statusById, ['4.1.2', '1.3.1']);
  const captionsControls = derived(statusById, ['1.2.2', '1.2.5']);
  const notAssessed = 'A platform or authoring requirement: not assessed in this audit.';
  out.push(
    table(
      [
        [
          '501.1 Scope (web content: WCAG 2.0 A and AA)',
          allOld.status,
          `Derived from all ${old.length} WCAG 2.0 level A and AA rows above: ${allOld.status}.`,
        ],
        ['502.2.1 User Control of Accessibility Features', 'Not Evaluated', notAssessed],
        ['502.2.2 No Disruption of Accessibility Features', 'Not Evaluated', notAssessed],
        [
          '502.3 Accessibility Services',
          accessibilityServices.status,
          accessibilityServices.remarks,
        ],
        ['502.4 Platform Accessibility Features', 'Not Evaluated', notAssessed],
        ['503.2 User Preferences', 'Not Evaluated', notAssessed],
        ['503.3 Alternate User Interfaces', 'Not Evaluated', notAssessed],
        [
          '503.4 User Controls for Captions and Audio Description',
          captionsControls.status,
          captionsControls.remarks,
        ],
        ['504.2 Content Creation or Editing', 'Not Evaluated', notAssessed],
        ['504.3 Prompts', 'Not Evaluated', notAssessed],
        ['504.4 Templates', 'Not Evaluated', notAssessed],
      ],
      ['Criteria', 'Conformance level', 'Remarks and explanations'],
    ),
  );
  out.push('');
  out.push('### Chapter 6: Support Documentation and Services');
  out.push('');
  out.push(
    table(
      [
        [
          '602.2 to 602.4 Support documentation',
          'Not Evaluated',
          'The documentation site and its formats were not assessed in this audit.',
        ],
        [
          '603.2 and 603.3 Support services',
          'Not Evaluated',
          'Support services were not assessed in this audit.',
        ],
      ],
      ['Criteria', 'Conformance level', 'Remarks and explanations'],
    ),
  );
  out.push('');

  // EN 301 549, derived.
  out.push('## EN 301 549 Report');
  out.push('');
  out.push(
    'Derived row by row from the WCAG rows, as above. EN 301 549 V3.2.1 cites WCAG 2.1; the WCAG 2.2 criteria are shown apart, for information.',
  );
  out.push('');
  out.push('### Clause 4: Functional Performance Statements');
  out.push('');
  const fpsRows = FPS_EN.map(([id, name, source, ids]) => {
    if (source)
      return [
        `${id} ${name}`,
        fpcStatus.get(source),
        `Derived from the same WCAG rows as Revised Section 508 ${source}: ${fpcStatus.get(source)}.`,
      ];
    const result = derived(statusById, ids ?? []);
    return [`${id} ${name}`, result.status, result.remarks];
  });
  out.push(table(fpsRows, ['Criteria', 'Conformance level', 'Remarks and explanations']));
  out.push('');
  out.push('### Clause 5: Generic requirements');
  out.push('');
  out.push(
    table(
      [
        [
          '5.1 to 5.9 Generic requirements',
          'Not Evaluated',
          'Requirements for closed functionality, biometrics, locking and hardware operable parts. Not assessed; the product has no closed functionality.',
        ],
      ],
      ['Criteria', 'Conformance level', 'Remarks and explanations'],
    ),
  );
  out.push('');
  out.push('### Clause 9: Web (WCAG 2.1 A and AA)');
  out.push('');
  const en = rows.filter((row) => ADDED_IN[row.id] !== '2.2');
  const enRows = en.map((row) => [
    `9.${row.id} ${row.criterion.name}`,
    row.status,
    `Derived from the WCAG 2.2 row ${row.id}.`,
  ]);
  enRows.push(['9.4.1.1 Parsing', 'Not Evaluated', 'Not evaluated: no test for it in this audit.']);
  out.push(table(enRows, ['Criteria', 'Conformance level', 'Remarks and explanations']));
  out.push('');
  out.push('WCAG 2.2 criteria that EN 301 549 V3.2.1 does not cite, for information:');
  out.push('');
  out.push(
    table(
      rows
        .filter((row) => ADDED_IN[row.id] === '2.2')
        .map((row) => [label(row.criterion), row.status, `The WCAG 2.2 row ${row.id}.`]),
      ['Criteria', 'Conformance level', 'Remarks and explanations'],
    ),
  );
  out.push('');
  out.push('### Clauses 10 to 12');
  out.push('');
  const web = derived(
    new Map(en.map((row) => [row.id, row.status])),
    en.map((row) => row.id),
  );
  out.push(
    table(
      [
        [
          '10 Non-web documents',
          'Not Evaluated',
          'Documents the product exports for a person (spreadsheets, files) were not assessed.',
        ],
        [
          '11 Software (web application)',
          web.status,
          `Software that is a web application is judged by clause 9: derived from all ${en.length} WCAG 2.1 A and AA rows: ${web.status}.`,
        ],
        [
          '12 Documentation and support services',
          'Not Evaluated',
          'The documentation site and support services were not assessed in this audit.',
        ],
      ],
      ['Criteria', 'Conformance level', 'Remarks and explanations'],
    ),
  );
  out.push('');

  // Coverage.
  out.push('## Coverage');
  out.push('');
  const coverage = evidence.routes.coverage ?? {};
  const coverageRows = Object.entries(coverage)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([route, roles]) => [
      route,
      Object.entries(roles)
        .map(
          ([role, value]) =>
            `${role}: ${value.pages ?? 0} page load${(value.pages ?? 0) === 1 ? '' : 's'}${value.redirected ? `, ${value.redirected} redirected to ${value.redirectedTo}` : ''}${value.skipped ? ', skipped (no fixture)' : ''}${value.failed ? `, ${value.failed} did not open` : ''}`,
        )
        .join('; '),
    ]);
  out.push(table(coverageRows, ['Route', 'Page loads audited, by role']));
  out.push('');
  out.push(
    `Findings: ${evidence.findings.length} in total, listed with their criterion, route and severity in [findings.md](findings.md). Keyboard walkthroughs: ${Object.keys(evidence.facts?.walkthroughs ?? {}).length}, of which ${Object.values(evidence.facts?.walkthroughs ?? {}).filter((walk) => walk.completed).length} completed.`,
  );
  out.push('');
  return `${out.join('\n')}`;
}

export function readInputs(dir = join(REPO_ROOT, 'docs', 'accessibility')) {
  return {
    evidence: JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8')),
    inspections: parseInspections(readFileSync(join(dir, 'inspections.md'), 'utf8')),
  };
}

export const CONTACT =
  'Open an issue at https://github.com/ncecere/open-chat-interface/issues and say "accessibility" in the title, or follow SECURITY.md for anything that is also a security matter.';

export function main(argv) {
  const options = { dir: join(REPO_ROOT, 'docs', 'accessibility'), final: false, version: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') options.dir = argv[++i];
    else if (argv[i] === '--final') options.final = true;
    else if (argv[i] === '--version') options.version = argv[++i];
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  const { evidence, inspections } = readInputs(options.dir);
  const version = options.version ?? evidence.app?.version;
  if (!version)
    throw new Error(
      'No version: pass --version, or run the audit from a checkout with apps/api/src/version.ts',
    );
  const markdown = renderReport({
    evidence,
    inspections,
    version,
    draft: !options.final,
    contact: CONTACT,
  });
  writeFileSync(join(options.dir, 'acr.md'), markdown);
  process.stderr.write(`wrote ${join(options.dir, 'acr.md')}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
