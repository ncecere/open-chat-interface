import {
  ARTIFACT_TOOL_IDS,
  artifactOfToolPart,
  DEFAULT_MAX_TOOL_STEPS,
  isDeclinedArtifactPart,
  type ToolLimitReason,
  type ToolStepSummary,
} from '@oci/shared';
import type { ReactNode } from 'react';
import { translatedNodes } from '~/components/chat/translated-nodes';
import { type MessageKey, type MessageParams, type Translate, translate } from '~/lib/i18n';

/**
 * What the conversation says about a tool step, in the language shown. The
 * shared package writes the same line in English for share pages and exports
 * (`summarizeToolPart`); this is the same decision tree with catalog
 * messages. What the step worked on (a search query, a memory, an artifact's
 * title) is content: it is put in as a placeholder, in a `<bdi>` where it is
 * drawn, and never translated.
 */

type Part = Record<string, unknown>;

/** The tool names this release knows, as a person reads them; others keep the name the server sent. */
const KNOWN_LABELS: Record<string, MessageKey> = {
  web_search: 'chat.toolLabel.webSearch',
  remember: 'chat.toolLabel.memory',
  forget: 'chat.toolLabel.memory',
  create_artifact: 'chat.toolLabel.createArtifact',
  update_artifact: 'chat.toolLabel.updateArtifact',
};

export function toolStepLabel(step: Pick<ToolStepSummary, 'toolId' | 'label'>): string {
  const key = KNOWN_LABELS[step.toolId];
  return key ? translate(key) : step.label;
}

/** `'text'` as the English line quotes it: one line, at most 80 characters. */
const quote = (value: string) => {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return `'${trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed}'`;
};

interface Described {
  key: MessageKey;
  /** What the step acted on, quoted; goes where the message has `{target}`. */
  target?: string;
  params?: MessageParams;
  /** The fallback provider's note, joined with a middle dot. */
  via?: string;
  /** A denial's reason, in parentheses after the line. */
  reason?: string;
}

function describe(part: Part, step: ToolStepSummary): Described {
  const { toolId, state } = step;
  const label = toolStepLabel(step);
  let described: Described;
  if (toolId === 'web_search') {
    const input = part.input as { query?: unknown } | undefined;
    const query = typeof input?.query === 'string' && input.query.trim() ? input.query : null;
    const target = query ? quote(query) : undefined;
    const suffix = query ? 'For' : '';
    if (state === 'done') {
      const output = part.output as
        | { results?: unknown; provider?: unknown; fallback?: unknown }
        | undefined;
      const count = Array.isArray(output?.results) ? output.results.length : 0;
      described = {
        key: `chat.toolSummary.webDone${suffix}` as MessageKey,
        target,
        params: { count },
        via:
          output?.fallback === true && typeof output.provider === 'string' && output.provider
            ? translate('chat.toolSummary.viaFallback', { provider: output.provider })
            : undefined,
      };
    } else if (state === 'error')
      described = { key: `chat.toolSummary.webFailed${suffix}` as MessageKey, target };
    else if (state === 'denied')
      described = { key: `chat.toolSummary.webNotRun${suffix}` as MessageKey, target };
    else described = { key: `chat.toolSummary.webRunning${suffix}` as MessageKey, target };
  } else if (toolId === 'remember' || toolId === 'forget') {
    const output = part.output as { content?: unknown; action?: unknown } | undefined;
    const input = part.input as { content?: unknown } | undefined;
    const text =
      typeof output?.content === 'string'
        ? output.content
        : typeof input?.content === 'string'
          ? input.content
          : '';
    const target = text.trim() ? quote(text) : undefined;
    const suffix = target ? 'Target' : '';
    const remember = toolId === 'remember';
    if (state === 'done')
      described = {
        key: (output?.action === 'exists'
          ? `chat.toolSummary.memoryExists${suffix}`
          : remember
            ? `chat.toolSummary.memoryRemembered${suffix}`
            : `chat.toolSummary.memoryForgot${suffix}`) as MessageKey,
        target,
      };
    else if (state === 'error')
      described = {
        key: remember ? 'chat.toolSummary.memorySaveFailed' : 'chat.toolSummary.memoryForgetFailed',
      };
    else if (state === 'denied') described = { key: 'chat.toolSummary.memoryNotChanged' };
    else
      described = {
        key: remember ? 'chat.toolSummary.memorySaving' : 'chat.toolSummary.memoryForgetting',
      };
  } else if ((ARTIFACT_TOOL_IDS as readonly string[]).includes(toolId)) {
    const created = toolId === 'create_artifact';
    const result = artifactOfToolPart(part);
    const input = part.input as { title?: unknown } | undefined;
    const title = result?.title ?? (typeof input?.title === 'string' ? input.title : null);
    const target = title ? quote(title) : undefined;
    const suffix = target ? 'Title' : '';
    if (isDeclinedArtifactPart(part))
      described = { key: `chat.toolSummary.artifactDeclined${suffix}` as MessageKey, target };
    else if (state === 'done' && result)
      described = created
        ? { key: `chat.toolSummary.artifactCreated${suffix}` as MessageKey, target }
        : {
            key: `chat.toolSummary.artifactUpdated${suffix}` as MessageKey,
            target,
            params: { version: result.version },
          };
    else if (state === 'error')
      described = {
        key: created
          ? 'chat.toolSummary.artifactCreateFailed'
          : 'chat.toolSummary.artifactUpdateFailed',
      };
    else if (state === 'denied')
      described = { key: 'chat.toolSummary.toolNotRun', params: { label } };
    else
      described = created
        ? { key: `chat.toolSummary.artifactCreating${suffix}` as MessageKey, target }
        : { key: 'chat.toolSummary.artifactUpdating' };
  } else if (state === 'done') described = { key: 'chat.toolSummary.toolUsed', params: { label } };
  else if (state === 'error') described = { key: 'chat.toolSummary.toolFailed', params: { label } };
  else if (state === 'denied')
    described = { key: 'chat.toolSummary.toolNotRun', params: { label } };
  else if (state === 'awaiting-approval')
    described = { key: 'chat.toolSummary.toolAwaiting', params: { label } };
  else described = { key: 'chat.toolSummary.toolUsing', params: { label } };
  if (state === 'denied' && step.reason) described.reason = step.reason;
  return described;
}

/** The step's one line, as text (announcements, labels). */
export function toolSummaryText(part: Part, step: ToolStepSummary): string {
  const { key, target, params, via, reason } = describe(part, step);
  let text = translate(key, { ...params, ...(target ? { target } : {}) });
  if (via) text = `${text} · ${via}`;
  return reason ? `${text} (${reason})` : text;
}

/** The step's one line where it is drawn: what it acted on in a `<bdi>`, so it cannot reorder the sentence. */
export function toolSummaryNode(t: Translate, part: Part, step: ToolStepSummary): ReactNode {
  const { key, target, params, via, reason } = describe(part, step);
  const sentence = target
    ? translatedNodes(t, key, { target: <bdi>{target}</bdi> }, params)
    : t(key, params);
  return (
    <>
      {sentence}
      {via ? ` · ${via}` : ''}
      {reason ? ` (${reason})` : ''}
    </>
  );
}

/** The note under a reply whose tool loop ended early. */
export function toolLimitText(reason: ToolLimitReason, steps?: number): string {
  if (reason === 'allowance') return translate('chat.toolLimit.allowance');
  if (reason === 'context') return translate('chat.toolLimit.context');
  return translate('chat.toolLimit.steps', { count: steps ?? DEFAULT_MAX_TOOL_STEPS });
}
