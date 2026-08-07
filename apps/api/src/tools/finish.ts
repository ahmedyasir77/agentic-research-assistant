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
      parseIfJsonArray,
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
        'remembered wording will be flagged as unsupported. Omit it, or pass an empty array, ' +
        'when the answer rests on no source.',
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
