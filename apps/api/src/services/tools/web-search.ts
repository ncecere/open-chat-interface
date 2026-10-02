import { z } from 'zod';
import { clip } from '../../lib/text.js';
import { roleFeatures } from '../role-features.js';
import { webSearchProblem } from '../search/availability.js';
import { normalizeSearchQuery, searchWeb } from '../search/index.js';
import { getSetting } from '../settings.js';
import type { ToolDefinition, ToolSource } from './types.js';

/** Bounds on what one search returns to the model and stores in the reply. */
const WEB_SEARCH_MAX_RESULTS = 10;
const MAX_TITLE_CHARS = 300;
const MAX_SNIPPET_CHARS = 600;
const MAX_URL_CHARS = 2_000;

interface WebSearchToolResult {
  query: string;
  results: Array<{ title: string; url: string; snippet: string }>;
}

/**
 * The `web_search` tool: the same providers, instance switch and role switch as
 * v0.7's single search, but the model decides when and what to search.
 */
export const webSearchTool: ToolDefinition = {
  id: 'web_search',
  label: 'Web search',
  description: [
    'Search the web for current information.',
    'Use it when the answer depends on recent events or facts you are unsure of.',
    'Cite factual claims with markdown links to the returned URLs, and do not invent sources.',
  ].join(' '),
  kind: 'read',
  source: 'builtin',
  inputSchema: z.object({
    query: z.string().trim().min(1).max(400).describe('What to search for, in a few words'),
  }),
  async available(turn) {
    if (!turn.webSearch) return false;
    const [features, search, role] = await Promise.all([
      getSetting('features'),
      getSetting('search'),
      roleFeatures(turn.role),
    ]);
    return role.webSearch && webSearchProblem(features, search) === null;
  },
  async execute(input) {
    const query = normalizeSearchQuery((input as { query: string }).query);
    const results = await searchWeb(query);
    return {
      query,
      results: results.slice(0, WEB_SEARCH_MAX_RESULTS).map((result) => ({
        title: clip(result.title, MAX_TITLE_CHARS),
        url: clip(result.url, MAX_URL_CHARS),
        snippet: clip(result.snippet, MAX_SNIPPET_CHARS),
      })),
    } satisfies WebSearchToolResult;
  },
  sources: (output) => webSearchSources(output),
};

/** Sources to show for a completed `web_search` result, in result order. */
export function webSearchSources(output: unknown): ToolSource[] {
  const results = (output as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((result) => {
    const candidate = result as { url?: unknown; title?: unknown } | null;
    if (typeof candidate?.url !== 'string' || !/^https?:\/\//i.test(candidate.url)) return [];
    return [
      {
        url: candidate.url,
        title:
          typeof candidate.title === 'string' && candidate.title ? candidate.title : candidate.url,
      },
    ];
  });
}
