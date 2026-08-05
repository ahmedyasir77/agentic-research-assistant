import { z } from 'zod';

import { JsonValueSchema } from './json.ts';

/** Long enough for a real research question, short enough that it cannot be an attack. */
export const MAX_QUERY_LENGTH = 500;

export const CreateRunRequestSchema = z.object({
  query: z.string().trim().min(3).max(MAX_QUERY_LENGTH),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;

export const CreateRunResponseSchema = z.object({
  runId: z.string().min(1),
  /** Where to subscribe for this run's events, so the client never builds URLs by hand. */
  eventsUrl: z.string().min(1),
});
export type CreateRunResponse = z.infer<typeof CreateRunResponseSchema>;

/**
 * What the browser needs to know before it starts a run: which mode the server was
 * deployed in, which model is answering, and whether this tab still understands the
 * event contract. Everything else about a run arrives in `run.started`.
 */
export const AppConfigSchema = z.object({
  demoMode: z.enum(['live', 'offline']),
  modelId: z.string().min(1),
  eventSchemaVersion: z.number().int().positive(),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

/** A tool as the model sees it: the same Zod schema, converted to JSON Schema. */
export const ToolSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: JsonValueSchema,
  timeoutMs: z.number().int().positive(),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

export const ListToolsResponseSchema = z.object({ tools: z.array(ToolSpecSchema) });
export type ListToolsResponse = z.infer<typeof ListToolsResponseSchema>;

/**
 * RFC 9457 problem details — the single error shape the API ever returns, so the
 * client has one thing to parse and one thing to render.
 */
export const ProblemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  /** Field-level validation failures, keyed by the path Zod reported. */
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
