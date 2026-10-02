import { providerCanEmbed } from '@oci/shared';
import { MockEmbeddingModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { fakeVector } from '../../../test/fake-embeddings.js';

vi.mock('../../db/index.js', () => ({ db: {} }));

const { embeddingModelKey, embeddingUsageSlug, isActive, normalizeEmbeddingsSettings } =
  await import('../../services/embeddings/config.js');
const { createEmbeddingModel } = await import('../../services/embeddings/model.js');
const { embedValues } = await import('../../services/embeddings/embed.js');
const { vectorLiteral } = await import('../../services/embeddings/storage.js');
const { fuseRankings, hybridRanking, HYBRID_TOP_K, RRF_K } = await import(
  '../../services/project-search/fusion.js'
);
const { batchByFile, failureBackoffMs } = await import(
  '../../services/project-search/embedding.js'
);

const id = (item: string) => item;

describe('reciprocal rank fusion', () => {
  it('scores items by their positions in every ranking', () => {
    // b: 1/62 + 1/61 beats a: 1/61 alone and c: 1/62 alone.
    expect(
      fuseRankings(
        [
          ['a', 'b'],
          ['b', 'c'],
        ],
        id,
        10,
      ),
    ).toEqual(['b', 'a', 'c']);
    expect(RRF_K).toBe(60);
  });

  it('keeps an exact keyword match first when the vector ranking also has it', () => {
    const keyword = ['code', 'x', 'y'];
    const vector = ['paraphrase', 'p2', 'p3', 'p4', 'code'];
    expect(fuseRankings([keyword, vector], id, 2)).toEqual(['code', 'paraphrase']);
  });

  it('breaks ties by first appearance, earlier rankings first, and honours the limit', () => {
    expect(fuseRankings([['a'], ['b']], id, 10)).toEqual(['a', 'b']);
    expect(fuseRankings([['a', 'b', 'c']], id, 2)).toEqual(['a', 'b']);
    expect(fuseRankings([['a']], id, 0)).toEqual([]);
    expect(fuseRankings([['a']], id, -1)).toEqual([]);
    expect(fuseRankings([], id, 5)).toEqual([]);
  });

  it('counts an item listed twice in one ranking once, at its best position', () => {
    expect(fuseRankings([['a', 'b', 'a'], ['b']], id, 10)).toEqual(['b', 'a']);
  });

  it('uses the given constant', () => {
    // With k = 0: a = 1/1, b = 1/2 + 1/1 = 1.5.
    expect(fuseRankings([['a', 'b'], ['b']], id, 10, 0)).toEqual(['b', 'a']);
  });

  it('works on objects through their key', () => {
    const items = [
      { attachmentId: 'f', ordinal: 1 },
      { attachmentId: 'f', ordinal: 2 },
    ];
    const key = (item: (typeof items)[number]) => `${item.attachmentId}:${item.ordinal}`;
    expect(fuseRankings([[items[0]!], [{ ...items[1]! }, { ...items[0]! }]], key, 5)).toEqual([
      items[0],
      items[1],
    ]);
  });
});

describe('hybrid ranking', () => {
  it('fuses the top of each ranking first, so a paraphrase is not buried by weak keyword matches', () => {
    // Every passage shares a common word with the message, so keyword search
    // ranks them all; the paraphrase ("target") is first by meaning only.
    const keyword = Array.from({ length: 30 }, (_, index) => `k${index}`);
    // Vector search returns every passage too: the closest in meaning first.
    const vector = [
      'target',
      ...Array.from({ length: 19 }, (_, index) => `v${index}`),
      ...[...keyword].reverse(),
    ];
    // Over whole lists, every keyword match (in both lists) outranks it.
    expect(fuseRankings([keyword, vector], id, 3)).not.toContain('target');
    const ranked = hybridRanking(keyword, vector, id, 3);
    expect(ranked).toEqual(['k0', 'target', 'k1']);
  });

  it('then fills the room with the rest of both rankings, without repeats', () => {
    const keyword = ['a', 'b', 'c', 'd'];
    const vector = ['x', 'b', 'y'];
    const ranked = hybridRanking(keyword, vector, id, 10, 2);
    expect(ranked.slice(0, 3)).toEqual(['b', 'a', 'x']);
    expect(new Set(ranked).size).toBe(ranked.length);
    expect(new Set(ranked)).toEqual(new Set(['a', 'b', 'c', 'd', 'x', 'y']));
    expect(hybridRanking(keyword, vector, id, 2, 2)).toEqual(['b', 'a']);
    expect(hybridRanking(keyword, vector, id, 0)).toEqual([]);
    expect(hybridRanking([], [], id, 5)).toEqual([]);
    expect(HYBRID_TOP_K).toBe(20);
  });
});

describe('embedding job batches', () => {
  const passage = (attachmentId: string, ordinal: number) => ({ attachmentId, ordinal });

  it('never mixes files in a batch and never exceeds the batch size', () => {
    const items = [
      passage('a', 0),
      passage('a', 1),
      passage('a', 2),
      passage('b', 0),
      passage('c', 0),
      passage('c', 1),
    ];
    expect(batchByFile(items, 2)).toEqual([
      [passage('a', 0), passage('a', 1)],
      [passage('a', 2)],
      [passage('b', 0)],
      [passage('c', 0), passage('c', 1)],
    ]);
    expect(batchByFile(items, 100).map((batch) => batch.length)).toEqual([3, 1, 2]);
    expect(batchByFile([], 3)).toEqual([]);
  });

  it('backs a failing file off for longer each time, up to six hours', () => {
    const minutes = (failures: number) => failureBackoffMs(failures) / 60_000;
    expect([1, 2, 3, 4].map(minutes)).toEqual([5, 10, 20, 40]);
    expect(minutes(0)).toBe(5);
    expect(minutes(30)).toBe(360);
  });
});

describe('embeddings settings', () => {
  it('reads an unsaved or partial setting as off', () => {
    expect(normalizeEmbeddingsSettings(undefined)).toEqual({
      enabled: false,
      providerId: null,
      modelId: null,
      dimensions: null,
      inputPriceMicros: null,
    });
    expect(normalizeEmbeddingsSettings({ enabled: true, modelId: 'm' })).toMatchObject({
      enabled: true,
      modelId: 'm',
      providerId: null,
    });
  });

  it('is active only with a provider, a model and its dimensions', () => {
    const complete = {
      enabled: true,
      providerId: 'p',
      modelId: 'm',
      dimensions: 3,
      inputPriceMicros: null,
    };
    expect(isActive(complete)).toBe(true);
    for (const missing of ['providerId', 'modelId', 'dimensions'] as const) {
      expect(isActive({ ...complete, [missing]: null })).toBe(false);
    }
    expect(isActive({ ...complete, enabled: false })).toBe(false);
    if (isActive(complete)) expect(embeddingModelKey(complete)).toBe('p/m/3');
    expect(embeddingUsageSlug('text-embedding-3-small')).toBe('embedding:text-embedding-3-small');
  });

  it('offers only provider kinds that can embed', () => {
    expect(providerCanEmbed('openai')).toBe(true);
    expect(providerCanEmbed('google')).toBe(true);
    expect(providerCanEmbed('openai-compatible')).toBe(true);
    expect(providerCanEmbed('anthropic')).toBe(false);
  });
});

describe('embeddings models', () => {
  const credentials = { label: 'P', apiKey: 'k', baseUrl: null };

  it('builds an embeddings model for each provider kind that has one', () => {
    expect(createEmbeddingModel({ ...credentials, kind: 'openai' }, 'e1').modelId).toBe('e1');
    expect(
      createEmbeddingModel({ ...credentials, kind: 'openai', baseUrl: 'https://x.test/v1' }, 'e1')
        .modelId,
    ).toBe('e1');
    expect(createEmbeddingModel({ ...credentials, kind: 'google' }, 'e2').modelId).toBe('e2');
    expect(
      createEmbeddingModel({ ...credentials, kind: 'google', baseUrl: 'https://g.test' }, 'e2')
        .modelId,
    ).toBe('e2');
    expect(
      createEmbeddingModel(
        { ...credentials, apiKey: null, kind: 'openai-compatible', baseUrl: 'http://l.test/v1' },
        'e3',
      ).modelId,
    ).toBe('e3');
    expect(
      createEmbeddingModel({ ...credentials, apiKey: null, kind: 'openai' }, 'e4').modelId,
    ).toBe('e4');
  });

  it('refuses Anthropic and an OpenAI-compatible provider without an address', () => {
    expect(() => createEmbeddingModel({ ...credentials, kind: 'anthropic' }, 'x')).toThrow(
      'P cannot create embeddings',
    );
    expect(() => createEmbeddingModel({ ...credentials, kind: 'openai-compatible' }, 'x')).toThrow(
      'require a base URL',
    );
  });
});

describe('embedding values', () => {
  const model = (embeddings: number[][], usage?: { tokens: number }) =>
    new MockEmbeddingModelV4({
      maxEmbeddingsPerCall: 100,
      doEmbed: async () => ({ embeddings, ...(usage && { usage }), warnings: [] }),
    });

  it('returns vectors in order with the reported tokens', async () => {
    await expect(
      embedValues(
        model(
          [
            [1, 2],
            [3, 4],
          ],
          { tokens: 7 },
        ),
        ['a', 'b'],
      ),
    ).resolves.toEqual({
      vectors: [
        [1, 2],
        [3, 4],
      ],
      tokens: 7,
    });
    await expect(embedValues(model([[1]]), ['a'], { dimensions: 1 })).resolves.toEqual({
      vectors: [[1]],
      tokens: 0,
    });
    await expect(embedValues(model([]), [])).resolves.toEqual({ vectors: [], tokens: 0 });
  });

  it('rejects a wrong count, wrong size or non-numeric vectors', async () => {
    await expect(embedValues(model([[1]]), ['a', 'b'])).rejects.toThrow(
      'returned 1 vectors for 2 passages',
    );
    await expect(embedValues(model([[1, 2]]), ['a'], { dimensions: 3 })).rejects.toThrow(
      'returned 2 dimensions; 3 were expected',
    );
    await expect(embedValues(model([[1, 2], [1]]), ['a', 'b'])).rejects.toThrow(
      'returned 1 dimensions; 2 were expected',
    );
    await expect(embedValues(model([[]]), ['a'])).rejects.toThrow('0 dimensions');
    await expect(embedValues(model([[1, Number.NaN]]), ['a'])).rejects.toThrow(
      'not a list of numbers',
    );
  });

  it('renders vectors in pgvector’s text form', () => {
    expect(vectorLiteral([1, -0.5, 2e-7])).toBe('[1,-0.5,2e-7]');
  });

  it('maps paraphrases close together in the test model', () => {
    const cosine = (a: number[], b: number[]) => {
      const dot = a.reduce((sum, value, index) => sum + value * b[index]!, 0);
      const norm = (v: number[]) => Math.sqrt(v.reduce((sum, value) => sum + value * value, 0));
      return dot / (norm(a) * norm(b));
    };
    const question = fakeVector('greenhouse heater startup password');
    expect(cosine(question, fakeVector('conservatory boiler ignition passphrase'))).toBeGreaterThan(
      cosine(question, fakeVector('kitchen rota pantry dishes')),
    );
  });
});
