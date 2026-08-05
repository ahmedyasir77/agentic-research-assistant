# Fixtures

Recorded model turns, search results and web pages. Together they make
`DEMO_MODE=offline` a complete, realistic run with **no API key and no network** —
the insurance policy for demoing on conference wifi.

| Directory | Replaces | Adapter |
| --------- | -------- | ------- |
| `llm/`    | The Anthropic Messages API | `apps/api/src/llm/fake.ts` |
| `search/` | The Tavily search API      | `apps/api/src/search/fixture.ts` |
| `pages/`  | The pages `http_get` fetches | `apps/api/src/platform/fixtureHttpClient.ts` |

## How a fixture is found

By slug, derived from the thing being looked up:

- `llm/` and `search/` — the slugified **query**. `Why is the sky blue?` →
  `why-is-the-sky-blue.json`. If there is no match, `default.json` is used, so an
  off-script question still produces a complete run rather than an empty one.
- `pages/` — the slugified **URL**. `https://en.wikipedia.org/wiki/Rayleigh_scattering`
  → `en-wikipedia-org-wiki-rayleigh-scattering.json`. An unrecorded URL returns a
  404 the agent can read and react to.

## What is checked in CI

`apps/api/src/fixtures.test.ts` holds every fixture to the same schemas the runtime
uses, and additionally asserts that:

- every filename matches the query or URL it records, so no fixture is unreachable;
- every recorded tool call passes the **real** tool input schema — a fixture cannot
  drift away from the tool it is pretending to call;
- every URL cited by a recorded `finish` call appears in a search fixture, so the
  demo does not trip its own citation check;
- every script ends by calling `finish`.

A broken fixture fails the build, not the demo.

## Recording a new one

1. Run once against the live providers: `DEMO_MODE=live SEARCH_PROVIDER=tavily pnpm dev`.
2. Fetch the run trace: `GET /api/runs/:id` (M5).
3. Copy the model turns into `llm/<slug>.json` and the tool results into
   `search/<slug>.json` and `pages/<url-slug>.json`.
4. Run `pnpm test` — the fixture tests will tell you if anything does not line up.
