import { CitationSchema } from '@ara/shared';
import { z } from 'zod';

import type { Tool } from './types.ts';

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
    .array(CitationSchema)
    .max(20)
    // Optional, because an answer can legitimately rest on no source: a run that
    // only did arithmetic has nothing to cite. Making it required cost a real run
    // four steps — the model kept sending a correct answer with no citations
    // field and kept being rejected, and the run failed with the answer in hand.
    .default([])
    .describe(
      'The sources the answer relies on. Every url must be one a tool returned during this run — ' +
        'urls that were not are flagged as unverified. Omit it, or pass an empty array, when the ' +
        'answer rests on no source.',
    ),
});

const OutputSchema = InputSchema;

/**
 * The final answer is a validated tool call rather than free text.
 *
 * That is the whole trick behind checkable citations: because the answer arrives
 * as structured data, the citation list is a machine-readable array that can be
 * cross-checked against the URLs tools actually returned. Free text would leave us
 * regex-scraping the model's prose and trusting what we found.
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
      'only way to finish a run. Cite only sources that appeared in tool results.',
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    timeoutMs: 1_000,
    // The tool does no work: the loop reads the validated arguments and ends the
    // run. Its value is entirely in the schema.
    execute: (input) => Promise.resolve(input),
  };
}

export type FinishPayload = z.infer<typeof InputSchema>;
export const FinishPayloadSchema = InputSchema;
