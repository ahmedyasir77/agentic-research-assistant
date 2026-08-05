import { z } from 'zod';

/**
 * Tool arguments and tool outputs are whatever the model and the tools agree on,
 * so on the wire they are typed as "any JSON value" rather than `unknown`. That
 * keeps them safe to serialise, safe to render, and impossible to smuggle a
 * function or a Date through.
 */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// The one place a type is written by hand rather than inferred: a recursive
// schema cannot infer its own type, so the annotation is what breaks the cycle.
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
