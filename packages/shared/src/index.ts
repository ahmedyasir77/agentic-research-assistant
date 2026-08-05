/**
 * The wire contract between the API and the browser. Anything that crosses that
 * boundary is defined once, here, as a Zod schema — the TypeScript types are
 * inferred from the schemas so the two can never drift.
 */
export const SHARED_CONTRACT_VERSION = 1;
