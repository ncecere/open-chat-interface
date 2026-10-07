import { plainTextOfMarkdown, SEARCH_HIGHLIGHT_END, SEARCH_HIGHLIGHT_START } from '@oci/shared';
import { describe, expect, it } from 'vitest';
import { tidySnippet } from '../../services/thread-search.js';

const S = SEARCH_HIGHLIGHT_START;
const E = SEARCH_HIGHLIGHT_END;

describe('conversation-search snippets (#206)', () => {
  it('read as text, with the matched words still marked', () => {
    // A ts_headline fragment of a numbered list with bold labels, as the QA walk saw it.
    expect(
      tidySnippet(
        `Reply: facts about owls:\n\n1. **360-degree head ${S}rotation${E}**: Owls can ${S}rotate${E} their heads … 2. **Silent Flight**: their`,
      ),
    ).toBe(
      `Reply: facts about owls: 1. 360-degree head ${S}rotation${E}: Owls can ${S}rotate${E} their heads … 2. Silent Flight: their`,
    );
    expect(tidySnippet(`# Ten Facts About ${S}Owls${E}\n\n- *Barn* owls`)).toBe(
      `Ten Facts About ${S}Owls${E} Barn owls`,
    );
  });

  it('keeps fragments that start or end inside the syntax readable', () => {
    expect(tidySnippet(`head rotation**: Owls can ${S}rotate${E}`)).toBe(
      `head rotation: Owls can ${S}rotate${E}`,
    );
    expect(tidySnippet(`see the \`config.${S}yaml${E}`)).toBe(`see the config.${S}yaml${E}`);
  });
});

describe('plainTextOfMarkdown', () => {
  it('keeps the words of links, images, code, quotes and tables', () => {
    expect(
      plainTextOfMarkdown(
        [
          '> Quoted **advice** and [the docs](https://example.com) with ![a chart](x.png)',
          '',
          '| Colour | Example |',
          '| --- | :---: |',
          '| Red | Apple |',
          '',
          '```python',
          'def reverse(text): return text[::-1]',
          '```',
          '',
          '---',
          'Use `**kwargs` and ~~old~~ new; 2 * 3 = 6; snake_case_name stays; \\*literal\\*',
        ].join('\n'),
      ).split('\n'),
    ).toEqual([
      'Quoted advice and the docs with a chart',
      '',
      'Colour · Example',
      'Red · Apple',
      '',
      'def reverse(text): return text[::-1]',
      '',
      'Use **kwargs and old new; 2 * 3 = 6; snake_case_name stays; *literal*',
    ]);
  });

  it('keeps list numbers and drops bullets and task boxes', () => {
    expect(plainTextOfMarkdown('1. First\n2) Second\n- [x] Done\n* Item')).toBe(
      '1. First\n2) Second\nDone\nItem',
    );
  });
});
