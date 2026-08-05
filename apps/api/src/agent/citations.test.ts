import { describe, expect, it } from 'vitest';

import { collectUrls, normaliseUrl, reviewCitations } from './citations.ts';

const cite = (id: number, url: string) => ({ id, url, title: `Source ${String(id)}` });

describe('reviewCitations', () => {
  it('verifies a citation a tool actually returned', () => {
    const review = reviewCitations(
      [cite(1, 'https://example.com/a')],
      new Set(['https://example.com/a']),
    );

    expect(review.citations[0]?.verified).toBe(true);
    expect(review.warnings).toStrictEqual([]);
  });

  it('flags a citation nothing returned, and names it in the warning', () => {
    const review = reviewCitations([cite(1, 'https://invented.example.com/paper')], new Set());

    expect(review.citations[0]?.verified).toBe(false);
    expect(review.warnings).toHaveLength(1);
    expect(review.warnings[0]?.message).toContain('invented.example.com');
  });

  it('keeps unverified citations rather than deleting them', () => {
    // Showing that the agent claimed a source and the check caught it is more
    // useful than quietly shortening the list.
    const review = reviewCitations(
      [cite(1, 'https://a.example.com'), cite(2, 'https://b.example.com')],
      new Set(['https://a.example.com']),
    );

    expect(review.citations).toHaveLength(2);
    expect(review.citations.map((entry) => entry.verified)).toStrictEqual([true, false]);
  });

  it('accepts an empty citation list without complaint', () => {
    expect(reviewCitations([], new Set())).toStrictEqual({ citations: [], warnings: [] });
  });
});

describe('normaliseUrl', () => {
  const equivalent: readonly (readonly [string, string])[] = [
    ['https://Example.com/a', 'https://example.com/a'],
    ['https://example.com/a/', 'https://example.com/a'],
    ['https://example.com/a#section', 'https://example.com/a'],
    ['HTTPS://example.com/a', 'https://example.com/a'],
  ];

  it.each(equivalent)('treats %s and %s as the same page', (left, right) => {
    expect(normaliseUrl(left)).toBe(normaliseUrl(right));
  });

  const distinct: readonly (readonly [string, string])[] = [
    // A different query is a different page — a normaliser that strips it would
    // verify citations that should have been caught.
    ['https://example.com/search?q=a', 'https://example.com/search?q=b'],
    ['https://example.com/a', 'https://example.com/b'],
    ['https://example.com/a', 'http://example.com/a'],
    ['https://example.com/', 'https://other.example.com/'],
  ];

  it.each(distinct)('keeps %s and %s distinct', (left, right) => {
    expect(normaliseUrl(left)).not.toBe(normaliseUrl(right));
  });

  it('falls back to a trimmed comparison for something that is not a url', () => {
    expect(normaliseUrl('  Not A URL  ')).toBe('not a url');
  });
});

describe('collectUrls', () => {
  it('finds urls wherever a tool result happens to put them', () => {
    const found = new Set<string>();
    collectUrls(
      {
        results: [{ url: 'https://a.example.com', nested: { deeper: ['https://b.example.com'] } }],
        finalUrl: 'https://c.example.com',
      },
      found,
    );

    expect([...found].sort()).toStrictEqual([
      'https://a.example.com',
      'https://b.example.com',
      'https://c.example.com',
    ]);
  });

  it('ignores strings that are not http urls', () => {
    const found = new Set<string>();
    collectUrls({ text: 'see example.com', scheme: 'file:///etc/passwd' }, found);

    expect(found.size).toBe(0);
  });
});
