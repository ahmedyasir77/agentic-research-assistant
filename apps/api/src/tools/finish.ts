import { CitationSchema } from '@ara/shared';
import { z } from 'zod';

import type { Tool } from './types.ts';

/**
 * Accepts a citations array that arrived as a JSON string.
 *
 * Models serialise a nested tool argument as a string often enough that rejecting it
 * is a step spent on nothing — the model had the citations, wrote them correctly,
 * and encoded them one layer too deep. Worse, the rejection misinforms: the array's
 * own `max(20)` is reported against the string as "expected string to have <=20
 * characters", which reads as an instruction to cut the answer's sources down to
 * twenty characters.
 *
 * Narrow on purpose. Only a string that parses to an array is unwrapped; anything
 * else is handed back untouched so the real validation error is the one the model
 * sees. The model-facing JSON schema is unchanged either way — it still advertises
 * an array, and this only forgives one way of getting that wrong.
 */
function parseIfJsonArray(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

const MAX_QUOTE_CHARS = 500;

/**
 * Trims an over-long quote rather than rejecting the call that carried it.
 *
 * `CitationSchema` caps a quote at 500 characters, and that cap is worth keeping —
 * a citation is meant to point at the sentence carrying the claim, not at half the
 * page. But enforcing it by rejection is the expensive way to hold that line: the
 * error names one citation and throws away all of them, along with the answer, so
 * the model has to regenerate the whole `finish` payload to fix a few characters at
 * the end of one quote. A real run spent its last two steps that way and died
 * holding a finished answer.
 *
 * Truncating is safe for the check that matters. Quotes are located by substring
 * search against the normalised text a tool returned, so a prefix of a quote that
 * was really in the page is still in the page — an over-copied quote stays
 * `quoted`, and a recalled one stays `unsupported`. The cut can land mid-word,
 * which is why the cap is a length the model is also told about: this is the floor
 * under a mistake, not the intended path.
 */
function clampQuotes(value: unknown): unknown {
  if (!Array.isArray(value)) return value;

  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) return item;
    const { quote } = item as { quote?: unknown };
    if (typeof quote !== 'string' || quote.length <= MAX_QUOTE_CHARS) return item;
    return { ...item, quote: quote.slice(0, MAX_QUOTE_CHARS) };
  });
}

const InputSchema = z.object({
  answer: z
    .string()
    .min(1)
    .max(8_000)
    .describe(
      'The final answer, in prose. Mark every claim taken from a source with a bracketed ' +
        'citation id like [1] that matches the citations array.',
    ),
  citations: z
    .preprocess(
      (value: unknown) => clampQuotes(parseIfJsonArray(value)),
      z
        .array(CitationSchema)
        .max(20)
        // Optional, because an answer can legitimately rest on no source: a run that
        // only did arithmetic has nothing to cite. Making it required cost a real run
        // four steps — the model kept sending a correct answer with no citations
        // field and kept being rejected, and the run failed with the answer in hand.
        .default([]),
    )
    .describe(
      'The sources the answer relies on. Every url must be one a tool returned during this run — ' +
        'urls that were not are flagged as unverified. Give each one a quote: the sentence from ' +
        'that source which supports the claim, copied exactly as it appeared in the tool result. ' +
        'Quotes are matched against that text character for character, so a paraphrase or a ' +
        `remembered wording will be flagged as unsupported. Keep each quote under ${String(MAX_QUOTE_CHARS)} ` +
        'characters — one sentence, not a paragraph; anything longer is trimmed to that length. ' +
        'Omit it, or pass an empty array, when the answer rests on no source.',
    ),
});

const OutputSchema = InputSchema;

/**
 * The final answer is a validated tool call rather than free text.
 *
 * That is the whole trick behind checkable citations: because the answer arrives
 * as structured data, the citation list is a machine-readable array that can be
 * cross-checked against what the tools actually returned — the URL against the set
 * they returned, and the quote against the text they returned for it. Free text
 * would leave us regex-scraping the model's prose and trusting what we found.
 */
export const FINISH_TOOL_NAME = 'finish';

export function createFinishTool(): Tool<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>
> {
  return {
    name: FINISH_TOOL_NAME,
    description:
      'Give the final answer and stop. Call this once you can answer the question — it is the ' +
      'only way to finish a run. Cite only sources that appeared in tool results, and quote the ' +
      'line in each source that carries the claim.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    timeoutMs: 1_000,
    // Its output echoes its input, so treating it as evidence would check the
    // answer against itself — passing every time and catching nothing.
    evidence: 'none',
    // The tool does no work: the loop reads the validated arguments and ends the
    // run. Its value is entirely in the schema.
    execute: (input) => Promise.resolve(input),
  };
}

export type FinishPayload = z.infer<typeof InputSchema>;
export const FinishPayloadSchema = InputSchema;
