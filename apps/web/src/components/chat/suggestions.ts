import { Code2, Compass, GraduationCap, Sparkles } from 'lucide-react';
import type { MessageKey } from '~/lib/i18n';

/**
 * The starter chips on the home page, as catalog keys: the label of each group
 * and the prompts a click sends. A prompt is the message the person sends, so
 * it is in the language shown.
 */
export const SUGGESTION_CATEGORIES = [
  {
    id: 'create',
    label: 'chat.suggestions.createLabel',
    icon: Sparkles,
    prompts: [
      'chat.suggestions.create1',
      'chat.suggestions.create2',
      'chat.suggestions.create3',
      'chat.suggestions.create4',
    ],
  },
  {
    id: 'explore',
    label: 'chat.suggestions.exploreLabel',
    icon: Compass,
    prompts: [
      'chat.suggestions.explore1',
      'chat.suggestions.explore2',
      'chat.suggestions.explore3',
      'chat.suggestions.explore4',
    ],
  },
  {
    id: 'code',
    label: 'chat.suggestions.codeLabel',
    icon: Code2,
    prompts: [
      'chat.suggestions.code1',
      'chat.suggestions.code2',
      'chat.suggestions.code3',
      'chat.suggestions.code4',
    ],
  },
  {
    id: 'learn',
    label: 'chat.suggestions.learnLabel',
    icon: GraduationCap,
    prompts: [
      'chat.suggestions.learn1',
      'chat.suggestions.learn2',
      'chat.suggestions.learn3',
      'chat.suggestions.learn4',
    ],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: MessageKey;
  icon: unknown;
  prompts: readonly MessageKey[];
}>;

export const DEFAULT_PROMPTS = [
  'chat.suggestions.default1',
  'chat.suggestions.default2',
  'chat.suggestions.default3',
  'chat.suggestions.default4',
] as const satisfies readonly MessageKey[];
