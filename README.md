# Agentic Research Assistant

Ask a research question and watch an LLM agent plan, call tools, observe the results and
repeat until it can answer — then read the answer with citations back to the exact sources
the tools actually returned.

The interesting part is not the happy path. It is the rails: per-tool timeouts, step and
wall-clock budgets, SSRF-guarded fetches, schema-validated tool arguments, and a citation
check that strips any URL the agent did not actually see.

> **Status:** under construction, milestone by milestone. See `docs/DECISIONS.md` for the
> choices made so far.

## Quickstart

```bash
pnpm install
pnpm build
pnpm test
```

## Layout

| Path              | What lives there                                              |
| ----------------- | ------------------------------------------------------------- |
| `apps/api`        | Express server, agent loop, tools, LLM and search adapters     |
| `apps/web`        | React UI — the live run timeline                               |
| `packages/shared` | Zod schemas for every byte that crosses the wire, used by both |
| `docs`            | Architecture, decisions, demo script                           |

## Scripts

| Script                | What it does                                       |
| --------------------- | -------------------------------------------------- |
| `pnpm build`          | Builds every package in dependency order           |
| `pnpm dev`            | Runs the API and the Vite dev server together      |
| `pnpm test`           | Runs every test suite — no network, no API key     |
| `pnpm test:coverage`  | Same, with coverage thresholds enforced            |
| `pnpm typecheck`      | `tsc --noEmit` across the workspace                |
| `pnpm lint`           | ESLint (type-checked rules)                        |
| `pnpm format:check`   | Prettier in check mode                             |

## Requirements

Node >= 22.18 (the API runs TypeScript directly via Node's native type stripping in dev)
and pnpm 10.
