import { formatDate, formatNumber, toDate } from './format';
import { type MessageNode, parseMessage } from './message-parse';

export type MessageParams = Record<string, string | number | Date | null | undefined>;

export interface MessageContext {
  /** The `Intl` tag, used for plural rules, numbers and dates. */
  locale: string;
  timeZone?: string;
}

const parsed = new Map<string, MessageNode[] | null>();

/** Parsed once per message text; null when it is not valid. */
function nodesFor(message: string): MessageNode[] | null {
  let nodes = parsed.get(message);
  if (nodes === undefined) {
    try {
      nodes = parseMessage(message);
    } catch {
      nodes = null;
    }
    parsed.set(message, nodes);
  }
  return nodes;
}

const pluralRules = new Map<string, Intl.PluralRules>();

function categoryFor(locale: string, n: number): string {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(n);
}

function render(
  nodes: readonly MessageNode[],
  params: MessageParams,
  context: MessageContext,
  pound: string | null,
): string {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') {
      out += node;
      continue;
    }
    switch (node.type) {
      case 'pound':
        out += pound ?? '#';
        break;
      case 'arg': {
        const value = params[node.name];
        out += value === undefined || value === null ? `{${node.name}}` : renderValue(value);
        break;
      }
      case 'number': {
        const value = params[node.name];
        const n = typeof value === 'number' ? value : Number.NaN;
        out +=
          Number.isFinite(n) && typeof value === 'number'
            ? formatNumber(n, { locale: context.locale, style: node.style })
            : value === undefined || value === null
              ? `{${node.name}}`
              : String(value);
        break;
      }
      case 'date': {
        const value = params[node.name];
        if (value === undefined || value === null) {
          out += `{${node.name}}`;
          break;
        }
        const style = node.style === 'long' ? 'long' : node.style === 'time' ? 'time' : 'short';
        out += toDate(value)
          ? formatDate(value, style, { locale: context.locale, timeZone: context.timeZone })
          : String(value);
        break;
      }
      case 'plural': {
        const value = params[node.name];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          const other = node.branches.other ?? [];
          out += render(
            other,
            params,
            context,
            value === undefined || value === null ? `{${node.name}}` : String(value),
          );
          break;
        }
        const shifted = value - node.offset;
        const branch =
          node.branches[`=${value}`] ??
          node.branches[categoryFor(context.locale, shifted)] ??
          node.branches.other ??
          [];
        out += render(branch, params, context, formatNumber(shifted, { locale: context.locale }));
        break;
      }
    }
  }
  return out;
}

function renderValue(value: string | number | Date): string {
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Fills a catalog message in. A message that is not valid ICU, or a value
 * that does not fit its argument, never throws: the message comes back as
 * written (or the value as given), so a translator's slip shows as odd text
 * instead of a blank screen. User text passed as a parameter is inserted as
 * text and never read as message syntax.
 */
export function formatMessage(
  message: string,
  params: MessageParams | undefined,
  context: MessageContext,
): string {
  const nodes = nodesFor(message);
  if (!nodes) return message;
  return render(nodes, params ?? {}, context, null);
}

/** Whether a message parses; the catalog loader uses it to choose the English fallback. */
export function isValidMessage(message: string): boolean {
  return nodesFor(message) !== null;
}
