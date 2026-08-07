import type { JsonValue } from '@ara/shared';
import { describe, expect, it } from 'vitest';

import {
  collectEvidence,
  createEvidence,
  failedCitations,
  normaliseText,
  normaliseUrl,
  reviewCitations,
  type Evidence,
} from './citations.ts';

const SOURCE = 'https://example.com/a';

const cite = (id: number, url: string, quote?: string) => ({
  id,
  url,
  title: `Source ${String(id)}`,
  ...(quote === undefined ? {} : { quote }),
});

/** Evidence as the loop builds it from pages a tool actually fetched. */
function evidenceFrom(...outputs: readonly JsonValue[]): Evidence {
  const evidence = createEvidence();
  for (const output of outputs) collectEvidence(output, evidence, 'fetched');
  return evidence;
}

/** The same, from a tool that only described the page instead of fetching it. */
function snippetEvidenceFrom(...outputs: readonly JsonValue[]): Evidence {
  const evidence = createEvidence();
  for (const output of outputs) collectEvidence(output, evidence, 'snippet');
  return evidence;
}

/** The texts filed under a url, provenance dropped, for assertions about routing. */
const textsFor = (evidence: Evidence, url: string): readonly string[] =>
  (evidence.textByUrl.get(url) ?? []).map((segment) => segment.text);

const PAGE = {
  finalUrl: SOURCE,
  textExcerpt:
    'Scattering theory has a long history. The scattered intensity is inversely ' +
    'proportional to the fourth power of the wavelength. That is why the effect is so steep.',
};

describe('reviewCitations', () => {
  it('grounds a citation whose quote is in the source it names', () => {
    const review = reviewCitations(
      [cite(1, SOURCE, 'inversely proportional to the fourth power of the wavelength')],
      evidenceFrom(PAGE),
    );

    expect(review.citations[0]?.grounding).toBe('quoted');
    expect(review.warnings).toStrictEqual([]);
  });

  it('returns the match in context so the passage can be read around it', () => {
    const review = reviewCitations(
      [cite(1, SOURCE, 'inversely proportional to the fourth power of the wavelength')],
      evidenceFrom(PAGE),
    );

    const match = review.citations[0]?.quoteMatch;
    expect(match?.match).toBe('inversely proportional to the fourth power of the wavelength');
    expect(match?.before).toContain('The scattered intensity is');
    expect(match?.after).toContain('That is why the effect is so steep.');
  });

  it('catches a real source quoted for a sentence it does not contain', () => {
    // The failure a URL check cannot see: the page is real, the agent read it, and
    // the sentence attributed to it was never in it.
    const review = reviewCitations(
      [cite(1, SOURCE, 'the scattered intensity is inversely proportional to the wavelength')],
      evidenceFrom(PAGE),
    );

    expect(review.citations[0]?.grounding).toBe('unsupported');
    expect(review.warnings[0]?.kind).toBe('unsupported_quote');
    expect(review.warnings[0]?.message).toContain(SOURCE);
  });

  it('will not let a quote match text attributed to a different source', () => {
    const results = {
      results: [
        { url: 'https://a.example.com', snippet: 'Alpha states the fourth power relationship.' },
        { url: 'https://b.example.com', snippet: 'Beta says something else entirely.' },
      ],
    };

    const review = reviewCitations(
      [cite(1, 'https://a.example.com', 'Beta says something else entirely.')],
      evidenceFrom(results),
    );

    expect(review.citations[0]?.grounding).toBe('unsupported');
  });

  it('will not let a quote span two separately returned strings', () => {
    // Title and snippet come back as distinct fields. Concatenating them would
    // manufacture a sentence the source never contained, and quoting that sentence
    // would then verify — so the two are kept apart.
    const result = {
      results: [
        {
          url: SOURCE,
          title: 'The first half of a sentence',
          snippet: 'and the second half of it',
        },
      ],
    };

    const review = reviewCitations(
      [cite(1, SOURCE, 'The first half of a sentence and the second half of it')],
      evidenceFrom(result),
    );

    expect(review.citations[0]?.grounding).toBe('unsupported');
  });

  it('rejects a quote too short to establish anything', () => {
    const review = reviewCitations([cite(1, SOURCE, 'scattering')], evidenceFrom(PAGE));

    expect(review.citations[0]?.grounding).toBe('unsupported');
    expect(review.warnings[0]?.message).toContain('too short');
  });

  it('marks a citation with no quote as checked at the source but not the claim', () => {
    const review = reviewCitations([cite(1, SOURCE)], evidenceFrom(PAGE));

    expect(review.citations[0]?.grounding).toBe('url_only');
    // Weaker than a quoted citation, but nothing went wrong — warning about it
    // every time would train people to ignore warnings.
    expect(review.warnings).toStrictEqual([]);
  });

  it('flags a citation nothing returned, and names it in the warning', () => {
    const review = reviewCitations(
      [cite(1, 'https://invented.example.com/paper')],
      evidenceFrom(PAGE),
    );

    expect(review.citations[0]?.grounding).toBe('unobserved');
    expect(review.warnings[0]?.kind).toBe('unverified_citation');
    expect(review.warnings[0]?.message).toContain('invented.example.com');
  });

  it('keeps citations that failed rather than deleting them', () => {
    // Showing that the agent claimed a source and the check caught it is more
    // useful than quietly shortening the list.
    const review = reviewCitations(
      [cite(1, SOURCE), cite(2, 'https://b.example.com')],
      evidenceFrom(PAGE),
    );

    expect(review.citations).toHaveLength(2);
    expect(review.citations.map((entry) => entry.grounding)).toStrictEqual([
      'url_only',
      'unobserved',
    ]);
  });

  it('accepts an empty citation list without complaint', () => {
    expect(reviewCitations([], createEvidence())).toStrictEqual({ citations: [], warnings: [] });
  });

  it('names the failing quote, so one source cited twice gives two distinct warnings', () => {
    const evidence = evidenceFrom(PAGE);
    const first = 'Scattering is proportional to the sixth power of the wavelength.';
    const second = 'The sky is green at midday in temperate latitudes.';

    const { warnings } = reviewCitations(
      [cite(2, SOURCE, first), cite(2, SOURCE, second)],
      evidence,
    );

    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.message).toContain('sixth power');
    expect(warnings[1]?.message).toContain('green at midday');
    expect(warnings[0]?.message).not.toBe(warnings[1]?.message);
  });

  describe('quotes taken from a search result rather than the page', () => {
    const SNIPPET = {
      results: [
        {
          url: SOURCE,
          title: 'Rayleigh scattering',
          snippet: 'The scattered intensity is inversely proportional to the fourth power.',
        },
      ],
    };

    it('labels a quote found only in a snippet as snippet, not quoted', () => {
      // The citation is honest and the source is real. What did not happen is a
      // reading of the page, and that is the thing the label has to carry.
      const review = reviewCitations(
        [cite(1, SOURCE, 'inversely proportional to the fourth power')],
        snippetEvidenceFrom(SNIPPET),
      );

      expect(review.citations[0]?.grounding).toBe('snippet');
    });

    it('still shows the passage it matched, so the reader can judge it', () => {
      const review = reviewCitations(
        [cite(1, SOURCE, 'inversely proportional to the fourth power')],
        snippetEvidenceFrom(SNIPPET),
      );

      expect(review.citations[0]?.quoteMatch?.match).toBe(
        'inversely proportional to the fourth power',
      );
    });

    it('does not warn, because nothing false was claimed', () => {
      const review = reviewCitations(
        [cite(1, SOURCE, 'inversely proportional to the fourth power')],
        snippetEvidenceFrom(SNIPPET),
      );

      expect(review.warnings).toStrictEqual([]);
    });

    it('credits the page when the sentence is in both, so the strongest true label wins', () => {
      const evidence = snippetEvidenceFrom(SNIPPET);
      collectEvidence(PAGE, evidence, 'fetched');

      const review = reviewCitations(
        [cite(1, SOURCE, 'inversely proportional to the fourth power of the wavelength')],
        evidence,
      );

      expect(review.citations[0]?.grounding).toBe('quoted');
    });

    it('still catches a quote in neither the snippet nor the page', () => {
      const review = reviewCitations(
        [cite(1, SOURCE, 'a sentence that appears in no source at all here')],
        snippetEvidenceFrom(SNIPPET),
      );

      expect(review.citations[0]?.grounding).toBe('unsupported');
      expect(review.warnings[0]?.kind).toBe('unsupported_quote');
    });
  });

  // The page as it came off the wire: a curly apostrophe and em dashes, which is
  // what rendered HTML actually contains.
  const TYPESET = {
    finalUrl: SOURCE,
    textExcerpt: 'It is the atmosphere’s own molecules — not dust — that scatter the light.',
  };

  const forgiven: readonly (readonly [string, string])[] = [
    ['typography copied exactly', 'atmosphere’s own molecules — not dust — that scatter'],
    ['a straight apostrophe and hyphens', "atmosphere's own molecules - not dust - that scatter"],
    ['a line break mid-sentence', "atmosphere's own molecules - not dust -\nthat scatter"],
    ['different case', "ATMOSPHERE'S OWN MOLECULES - NOT DUST - THAT SCATTER"],
  ];

  it.each(forgiven)('matches through %s', (_label, quote) => {
    // Every one of these is invisible on screen and fatal to an exact match. None
    // of them changes which words are present, which is the line being held.
    const review = reviewCitations([cite(1, SOURCE, quote)], evidenceFrom(TYPESET));

    expect(review.citations[0]?.grounding).toBe('quoted');
  });
});

describe('failedCitations', () => {
  it('separates a url nothing returned from a quote the page does not contain', () => {
    const evidence = evidenceFrom(PAGE);
    const failed = failedCitations(
      [
        cite(1, SOURCE, 'The scattered intensity is inversely proportional'),
        cite(2, SOURCE, 'Scattering follows the sixth power of the wavelength.'),
        cite(3, 'https://example.com/never-returned', 'Anything at all, at some length.'),
        cite(4, SOURCE),
      ],
      evidence,
    );

    // The two failures are told apart because their fixes are different: one is
    // re-read and copied, the other cannot be re-read at all. A grounded quote is
    // fine, and a citation with no quote was never a claim about the page's wording.
    expect(failed.unsupported.map((citation) => citation.id)).toStrictEqual([2]);
    expect(failed.unobserved.map((citation) => citation.id)).toStrictEqual([3]);
  });

  it('finds nothing to correct when every citation holds up', () => {
    const evidence = evidenceFrom(PAGE);
    const held = cite(1, SOURCE, 'The scattered intensity is inversely proportional');

    expect(failedCitations([held], evidence)).toStrictEqual({ unobserved: [], unsupported: [] });
  });
});

describe('duplicate warnings', () => {
  it('reports one warning for the same invented source cited twice', () => {
    const invented = 'https://example.com/never-returned';
    const review = reviewCitations([cite(2, invented), cite(2, invented)], evidenceFrom(PAGE));

    // Both citations are kept and labelled — nothing that failed is deleted. But the
    // warning built from an id and a URL is byte-identical for both, and the same
    // sentence twice says nothing the first one did not.
    expect(review.citations.map((citation) => citation.grounding)).toStrictEqual([
      'unobserved',
      'unobserved',
    ]);
    expect(review.warnings).toHaveLength(1);
  });

  it('still reports both when one source fails two different quotes', () => {
    const review = reviewCitations(
      [
        cite(1, SOURCE, 'Scattering follows the sixth power of the wavelength.'),
        cite(1, SOURCE, 'Red light scatters twice as far as blue light does.'),
      ],
      evidenceFrom(PAGE),
    );

    // The quote is in the message, so these are two distinguishable failures rather
    // than one repeated — deduplicating on the text must not collapse them.
    expect(review.warnings).toHaveLength(2);
  });
});

describe('a page read in more than one piece', () => {
  // Two `http_get` results for one URL, shaped as the tool returns them. The reads
  // overlap by the quote cap, which is what makes the straddling sentence whole in
  // the second one — see OVERLAP_CHARS in tools/httpGet.ts.
  const SENTENCE =
    'In a University of Chicago study on sleep deprivation, the volunteers who stayed ' +
    'awake showed measurable metabolic changes within a week.';

  const EXCERPT = 12_000;
  const OVERLAP = 500;
  // The sentence sits 40 characters before the first read's cut, so that read ends
  // in the middle of it — the shape that used to be unquotable.
  const PAGE = `${'x'.repeat(EXCERPT - 40)}${SENTENCE}${'y'.repeat(2_000)}`;

  const chunk = (excerpt: string, offset: number): JsonValue => ({
    status: 200,
    contentType: 'text/plain',
    textExcerpt: excerpt,
    truncated: true,
    offset,
    totalChars: PAGE.length,
    finalUrl: SOURCE,
  });

  it('grounds a quote the first read cut in half', () => {
    const evidence = evidenceFrom(
      chunk(PAGE.slice(0, EXCERPT), 0),
      chunk(PAGE.slice(EXCERPT - OVERLAP), EXCERPT - OVERLAP),
    );

    // The evidence segments are still kept apart — nothing here joins them, which is
    // what stops a quote spanning a title and a snippet. The overlap means it does
    // not have to: the sentence is whole inside the second read on its own.
    const review = reviewCitations([cite(1, SOURCE, SENTENCE)], evidence);

    expect(review.citations[0]?.grounding).toBe('quoted');
    expect(review.warnings).toStrictEqual([]);
  });

  it('still refuses a quote spanning two reads that do not overlap', () => {
    // The safety property the overlap must not cost: two independently returned
    // strings are never concatenated into a sentence neither of them contained. Take
    // the overlap away and the same quote is correctly rejected again.
    const evidence = evidenceFrom(
      chunk(PAGE.slice(0, EXCERPT), 0),
      chunk(PAGE.slice(EXCERPT), EXCERPT),
    );

    expect(reviewCitations([cite(1, SOURCE, SENTENCE)], evidence).citations[0]?.grounding).toBe(
      'unsupported',
    );
  });
});

describe('collectEvidence', () => {
  it('finds urls wherever a tool result happens to put them', () => {
    const evidence = evidenceFrom({
      results: [{ url: 'https://a.example.com', nested: { deeper: ['https://b.example.com'] } }],
      finalUrl: 'https://c.example.com',
    });

    expect([...evidence.urls].sort()).toStrictEqual([
      'https://a.example.com/',
      'https://b.example.com/',
      'https://c.example.com/',
    ]);
  });

  it('ignores strings that are not http urls', () => {
    const evidence = evidenceFrom({ text: 'see example.com', scheme: 'file:///etc/passwd' });

    expect(evidence.urls.size).toBe(0);
  });

  it('files each search result under its own url rather than its siblings', () => {
    const evidence = evidenceFrom({
      results: [
        { url: 'https://a.example.com', snippet: 'about alpha' },
        { url: 'https://b.example.com', snippet: 'about beta' },
      ],
    });

    expect(textsFor(evidence, 'https://a.example.com/')).toContain('about alpha');
    expect(textsFor(evidence, 'https://a.example.com/')).not.toContain('about beta');
  });

  it('files a fetched page under the url it was finally read from', () => {
    const evidence = evidenceFrom({
      status: 200,
      finalUrl: 'https://example.com/redirected',
      textExcerpt: 'the body of the page',
    });

    expect(textsFor(evidence, 'https://example.com/redirected')).toContain('the body of the page');
  });

  it('tags each segment with what the tool that produced it was worth', () => {
    const evidence = snippetEvidenceFrom({
      results: [{ url: 'https://a.example.com', snippet: 'about alpha' }],
    });

    expect(evidence.textByUrl.get('https://a.example.com/')).toStrictEqual([
      { text: 'about alpha', provenance: 'snippet' },
    ]);
  });

  it('keeps segments apart so a quote cannot match across two of them', () => {
    // A title and a snippet joined would read as one sentence neither contained.
    const evidence = snippetEvidenceFrom({
      results: [
        { url: 'https://a.example.com', title: 'Rayleigh scattering', snippet: 'is steep' },
      ],
    });

    const review = reviewCitations(
      [cite(1, 'https://a.example.com', 'Rayleigh scattering is steep')],
      evidence,
    );

    expect(review.citations[0]?.grounding).toBe('unsupported');
  });
});

describe('normaliseText', () => {
  it('collapses whitespace without joining separate words', () => {
    expect(normaliseText('  one   two \n three  ')).toBe('one two three');
  });

  it('preserves case, because the matched passage is shown to the reader', () => {
    expect(normaliseText('Rayleigh Scattering')).toBe('Rayleigh Scattering');
  });

  it('strips control characters, so no quote can forge an attribution boundary', () => {
    expect(normaliseText('before\u0000after')).toBe('before after');
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
