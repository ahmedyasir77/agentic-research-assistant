# Agentic Research Assistant

Ask a research question and watch an LLM agent plan, call tools, observe the results
and repeat until it can answer — then read the answer with citations back to the
exact sources the tools actually returned. Every step of the loop streams to the
browser as it happens, so the agent's reasoning is something you watch rather than
something you take on faith.

The interesting part is not the happy path. It is the rails: per-tool timeouts, step
and wall-clock budgets, SSRF-guarded fetches, schema-validated tool arguments, and a
citation check that strips any URL the agent did not actually see. **That last one
is the anti-hallucination check** — a model can write any URL it likes into its
answer, and this one is cross-checked against the set of URLs the tools really
returned during the run. Anything that fails is stripped from the answer and
surfaced in the trace as a warning.

![The offline demo mid-run: the reason-act timeline, each tool call with its arguments and result, and the cited answer.](docs/demo.png)

---

## 60-second quickstart

No API key. No network. No configuration.

```bash
pnpm install
pnpm demo          # → http://localhost:8080
```

That is the whole demo. `DEMO_MODE=offline` replays recorded model turns and
recorded search results through the **real** agent loop, the real tools, the real
SSRF guard and the real citation check — offline mode swaps transports, not
guardrails. Click "Why is the sky blue?" and watch four steps run.

To point it at the real APIs instead:

```bash
cp .env.example .env.local     # fill in ANTHROPIC_API_KEY (and TAVILY_API_KEY, optionally)
pnpm live
```

`.env.local` is gitignored and read by Node's own `--env-file-if-exists` — there is
no dotenv dependency and no key in the repository.

---

## Architecture

```mermaid
flowchart TB
    subgraph browser["Browser — React 19"]
        UI["App.tsx"] --> HOOK["useRunStream<br/>EventSource + Last-Event-ID"]
        HOOK --> RED["runReducer<br/>events → view state"]
    end

    subgraph api["API — Express 5"]
        RT["routes/runs.ts<br/>POST /api/runs · GET /:id/events"]
        STORE["RunStore<br/>bounded · TTL · 503 at capacity"]
        EM["RunEmitter<br/>replayable by seq"]
    end

    subgraph agent["Agent — no I/O, fully injected"]
        LOOP["loop.ts<br/>AsyncGenerator&lt;AgentEvent, RunTrace&gt;"]
        POL["policy.ts<br/>steps · wall clock · calls per step"]
        CIT["citations.ts<br/>verify against what tools returned"]
        REG["ToolRegistry<br/>Zod in · ToolOutcome out · never throws"]
    end

    subgraph ports["Ports"]
        LLM["LlmClient"]
        SEARCH["SearchProvider"]
        HTTP["HttpClient + SSRF guard"]
    end

    subgraph adapters["Adapters — chosen in composition.ts"]
        ANTH["anthropic.ts"]
        FAKE["fake.ts (recorded)"]
        TAV["tavily.ts"]
        FIX["fixture.ts (recorded)"]
    end

    UI -->|"POST"| RT
    HOOK -->|"SSE"| RT
    RT --> STORE --> EM
    RT --> LOOP
    LOOP --> POL
    LOOP --> REG
    LOOP --> CIT
    LOOP --> LLM
    REG --> SEARCH
    REG --> HTTP
    LLM --> ANTH
    LLM --> FAKE
    SEARCH --> TAV
    SEARCH --> FIX

    SHARED["packages/shared — Zod schemas for every byte on the wire"]
    SHARED -.-> browser
    SHARED -.-> api
```

`agent/loop.ts` performs no I/O and imports nothing from Express. It takes
`{ llm, tools, policy, clock, logger }` and yields events. That is what makes the
whole agent testable with a scripted model, and why `DEMO_MODE=offline` needs no
branch anywhere except `composition.ts`.

Full detail — request lifecycle, sequence diagram, guardrail inventory, alerting —
is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**. The reasoning behind each
choice is in **[docs/DECISIONS.md](docs/DECISIONS.md)**. The demo script is in
**[docs/DEMO.md](docs/DEMO.md)**.

---

## The four tools

| Tool | Input | Guarded by |
| --- | --- | --- |
| `web_search` | `{ query, maxResults? }` | Provider port — Tavily live, recorded fixtures offline |
| `http_get` | `{ url }` | DNS-resolved SSRF check, re-run after every redirect; 2 redirects, 5s, 1 MB, content-type allowlist |
| `calculator` | `{ expression }` | An explicit tokenizer and shunting-yard evaluator. Never `eval`, never `new Function`, never `vm` |
| `finish` | `{ answer, citations }` | Every citation URL cross-checked against what the tools returned |

Adding a fifth is one new file plus one line in `tools/index.ts`. The Zod schema
that validates the model's arguments is the same schema converted to JSON Schema and
handed to the model — one definition, no drift.

---

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm demo` | Offline demo on :8080 — no keys, no network, serves the UI too |
| `pnpm live` | Same, against the real Anthropic and Tavily APIs, reading `.env.local` |
| `pnpm dev` | API on :8080 and the Vite dev server on :5173, with HMR |
| `pnpm build` | Shared contracts, then the API, then the web bundle |
| `pnpm test` | Every suite — passes with no network and no API key |
| `pnpm test:coverage` | Same, with thresholds on `agent/`, `tools/` and `platform/` |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm lint` | ESLint with type-checked rules |
| `pnpm format:check` | Prettier in check mode |
| `./infra/deploy.sh` | Idempotent deploy to Azure Container Apps; echoes the URL |

---

## Layout

| Path | What lives there |
| --- | --- |
| `apps/api` | Express server, agent loop, tools, LLM and search adapters |
| `apps/web` | React UI — the live run timeline |
| `packages/shared` | Zod schemas for every byte that crosses the wire, used by both |
| `fixtures` | Recorded model turns, search results and pages for the offline demo |
| `infra` | Dockerfile, bicep template, deploy script |
| `docs` | Architecture, decisions, demo script |

---

## Requirements

Node ≥ 22.18 and pnpm 10. The API runs TypeScript directly via Node's native type
stripping in development, so there is no bundler and no watcher to explain — and it
compiles with `tsc` for production.

---

## Deploying

```bash
./infra/deploy.sh                                    # offline demo, no keys needed
DEMO_MODE=live SEARCH_PROVIDER=tavily ./infra/deploy.sh   # after sourcing .env.local
```

One container on Azure Container Apps: Express serves the API and the built React
bundle from the same process. The script creates the resource group and registry if
they are missing, builds the image server-side with `az acr build` (no local Docker
required), deploys the bicep template, and prints the URL. API keys become Container
App **secrets** referenced by `secretRef` — never plain environment values.

---

## What I'd do next

In the order I would actually do it.

1. **A shared run store.** Runs live in one process's memory, which is why the
   Container App is capped at two replicas with sticky sessions. Redis behind the
   existing `RunStore` interface would remove the cap and let a reconnect land
   anywhere. This is the single biggest gap between this and something I would put
   real traffic on.
2. **Stream the model's tokens.** The Anthropic adapter uses the non-streaming
   Messages API, so `agent.message` arrives per turn rather than per token. The
   event type (`answer.delta`) and the SSE plumbing already exist; the work is in
   the adapter. It would cut perceived latency more than any other change here.
3. **Persist traces.** A run disappears when the TTL expires. Writing the `RunTrace`
   somewhere durable would turn the demo into an evaluation set — the same twenty
   questions, replayed against a new prompt or a new model, diffed.
4. **A real eval harness.** Right now correctness is "six deterministic scenarios
   pass". That proves the loop's mechanics, not the agent's judgment. Scoring answer
   quality and citation precision across a fixed question set is what would let me
   change the system prompt with any confidence.
5. **Managed identity instead of registry credentials.** The deploy uses the ACR
   admin user because it works in one pass with only Contributor. A system-assigned
   identity with an `AcrPull` role assignment is the right answer and needs a
   two-phase deployment — see ADR-034.
6. **Per-user rate limits.** The limiter counts by IP, which is the right default
   with no auth. The moment there is auth, it should count by principal.

What I deliberately left out: a database, authentication, a job queue, and a second
LLM provider. Each is a real feature with real cost, and none of them makes the
reason-act loop — the actual subject of this project — any clearer.
