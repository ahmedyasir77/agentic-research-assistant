# Architecture

How a question becomes a cited answer, and what stops it going wrong.

The short version: an HTTP request creates a run, an async generator drives a
reason-act loop over four tools, every step is appended to a trace, and the browser
watches the whole thing over Server-Sent Events. Nothing is persisted. Nothing is
shared between processes.

---

## Request lifecycle

A run is created and subscribed to in two requests, not one.

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant API as Express
    participant S as RunStore
    participant L as AgentLoop
    participant M as LlmClient
    participant T as ToolRegistry

    B->>API: POST /api/runs {query}
    API->>API: CreateRunRequestSchema.parse
    API->>S: reserve a slot (503 if at capacity)
    API-->>B: 202 {runId, eventsUrl}
    Note over API,L: The loop is already running; nobody is watching yet.

    B->>API: GET /api/runs/:id/events (EventSource)
    API->>S: subscribe, replaying from Last-Event-ID
    S-->>B: run.started

    loop until finish, budget, or failure
        L->>L: checkBudget(policy, {step, elapsedMs})
        L->>M: complete(messages + tool specs)
        M-->>L: text and tool_use blocks
        S-->>B: agent.step.started, agent.message
        L->>T: invoke(name, rawArgs) — parallel, capped per step
        T-->>L: ToolOutcome (never throws)
        S-->>B: tool.called, tool.succeeded / tool.failed
        L->>L: append tool_result blocks
    end

    L->>T: invoke("finish", {answer, citations})
    L->>L: reviewCitations(payload, evidence tools returned)
    S-->>B: run.completed {answer, citations, warnings}
    B->>API: GET /api/runs/:id
    API-->>B: the full RunTrace
```

Three details in that diagram are the design.

**The POST returns before the run finishes.** `202`, not `201` — the run is accepted
and under way. The browser then subscribes with `EventSource`, which reconnects on
its own and sends `Last-Event-ID`; the emitter replays from that sequence number, so
a dropped connection re-attaches to a run that never stopped. Streaming out of the
POST itself would have made all of that the client's problem. (ADR-019.)

**Tool invocation never throws.** `ToolRegistry.invoke` returns a discriminated
`ToolOutcome`. A model that sends malformed arguments gets a `tool_result` with
`is_error: true` and a readable message, and gets to correct itself on the next
turn. Bad model output is a normal Tuesday, not an exception.

**Citations are verified against what the tools returned**, not against the model's
say-so — the URL against the set they returned, and the quote against the text they
returned for it. The `finish` payload arrives as validated structured data precisely
so this check is possible — see [Guardrails](#guardrails).

---

## Module map

```
apps/api/src/
  agent/        the reason-act loop and its rails
    loop.ts       runAgent(): AsyncGenerator<AgentEvent, RunTrace> — yields events, returns the trace
    outcome.ts    recordStep / complete / fail — the bookkeeping of stopping
    policy.ts     every budget in one object, plus checkBudget
    citations.ts  the grounding check: evidence collection, url and quote verification
    prompt.ts     the system prompt, and only the system prompt
    recorder.ts   accumulates the RunTrace as the loop runs
    toolStep.ts   executes one turn's tool calls, in parallel, under the per-step cap
  tools/        registry.ts + the four tools; each one file
  llm/          port.ts (the interface) · anthropic.ts (real) · fake.ts (recorded) · pricing.ts
  search/       port.ts · tavily.ts (real) · fixture.ts (recorded)
  http/         server.ts · sse.ts · problem.ts · static.ts · routes/ · middleware/
  runs/         store.ts (bounded, TTL) · emitter.ts (replayable) · startRun.ts
  platform/     retry · timeout · ssrf · guardedGet · logger · metrics · redact · transient
  config/       env.ts (the only reader of process.env) · secret.ts · paths.ts
  composition.ts  the one file that knows which adapters are real
  main.ts         parse config, build a logger, mount, listen

packages/shared/src/   Zod schemas for every byte that crosses the wire
apps/web/src/          App · components/ · hooks/useRunStream · lib/runReducer
```

The rule that keeps this readable: **`agent/loop.ts` performs no I/O.** It receives
`{ llm, tools, policy, clock, logger }` and imports nothing from Express. That is
why the entire agent is testable with a scripted model and no network, and why
`DEMO_MODE=offline` needs no branch outside `composition.ts`.

### Ports and their adapters

| Port | Real | Recorded | Swapped in |
| --- | --- | --- | --- |
| `LlmClient` | `llm/anthropic.ts` | `llm/fake.ts` | `composition.ts` |
| `SearchProvider` | `search/tavily.ts` | `search/fixture.ts` | `composition.ts` |
| `HttpClient` | `platform/httpClient.ts` | `platform/fixtureHttpClient.ts` | `composition.ts` |
| `DnsResolver` | `platform/ssrf.ts` | `platform/fixtureHttpClient.ts` | `composition.ts` |
| `JsonPoster` | `platform/jsonPost.ts` | msw, in adapter tests | `composition.ts` |

Offline mode swaps **transports only**. The SSRF guard, the timeouts, the retry
policy and the citation check all run exactly as they do live — which is what makes
the offline demo worth showing rather than a cardboard cutout.

---

## Guardrails

Every limit lives in `agent/policy.ts` as one typed object, so the answer to "what
stops it looping forever" is a file rather than a story.

| Guardrail | Where | What it does |
| --- | --- | --- |
| Step budget | `agent/policy.ts` | 20 steps. Checked **before** each step, so the run stops with a partial answer rather than spending another model call. |
| Wall-clock budget | `agent/policy.ts` | 180s, same check, same place — plus the same deadline as an `AbortSignal`, so a model call still writing when the budget runs out is cut off and reported as a spent budget rather than a provider failure. |
| Tool calls per step | `agent/toolStep.ts` | 3. A model that asks for twenty parallel fetches gets three. |
| Output token cap | `agent/policy.ts` | Passed to the model on every turn. |
| Nudge limit | `agent/loop.ts` | A model that answers in prose is told once to use `finish`. Twice and the run ends `no_tool_call` — no third try. |
| Per-tool timeout | `tools/registry.ts` | Declared per tool, enforced by `platform/timeout.ts`. |
| Argument validation | `tools/registry.ts` | Zod parse before any side effect. Failure is a `tool_result`, not a crash. |
| SSRF guard | `platform/ssrf.ts` | Scheme allowlist, no credentials in URL, DNS resolved and checked against loopback / private / link-local / unique-local — **re-checked after every redirect**. Max 2 redirects, 5s timeout, 1 MB cap enforced by streaming and aborting, content-type allowlist. |
| No `eval`, ever | `tools/calculator.ts` | An explicit tokenizer and shunting-yard evaluator. A `process.exit(0)` payload is a parse error, and there is a test that says so. |
| Citation integrity | `agent/citations.ts` | Every URL in the `finish` payload is checked against the set of URLs tools actually returned this run. |
| Claim grounding | `agent/citations.ts` | Every citation's quote is matched against the text that URL returned — attributed per URL, never pooled, exact after normalising only what is invisible. Each citation is labelled `quoted` / `unsupported` / `url_only` / `unobserved`; the two failing states carry a warning. Nothing is deleted. |
| Ingress limits | `http/` | 500-character query, 8 KB body, per-IP rate limit on run creation. |
| Backpressure | `runs/store.ts` | Bounded store with a TTL. At capacity, `POST /api/runs` is `503` — shedding load rather than growing without bound. |
| Redaction | `platform/redact.ts` | `authorization` and `x-api-key` never reach the log. API keys are a `Secret` type whose `toString` and `toJSON` return `[redacted]`; reading one takes an explicit `.expose()`. |

The failure mode these share: **a guardrail firing ends the run with a reason, never
with an unhandled rejection.** `RunFailureReason` is a closed union in the shared
schemas, and the UI renders each case.

---

## Reliability

`platform/retry.ts` is one generic `withRetry`. Exponential backoff with full
jitter, three attempts, `Retry-After` honoured when present, and an `AbortSignal`
that stops it. It retries only what is worth retrying — network errors, timeouts,
408, 429, 5xx — and `platform/transient.ts` is the single place that decides which
is which, including through wrapper errors an adapter has thrown around a cause.

A 400 fails once, immediately. Retrying a request the server has already told you is
malformed is how a bug becomes an outage.

Shutdown is ordered, in `http/shutdown.ts`: stop accepting (readiness starts
failing), let in-flight runs finish, close idle sockets, then exit. A container
being asked to stop is the ordinary case, not an emergency.

---

## Observability

Structured JSON logs from pino, one request id per request, and one summary line
per run: outcome, steps, duration, tool calls, tokens, estimated cost.

`GET /metrics` exposes:

| Metric | Type | Labels |
| --- | --- | --- |
| `agent_runs_total` | counter | `outcome` |
| `agent_steps_per_run` | histogram | — |
| `tool_calls_total` | counter | `tool`, `outcome` |
| `tool_duration_seconds` | histogram | `tool` |
| `llm_tokens_total` | counter | `type` |
| `llm_request_duration_seconds` | histogram | `model`, `outcome` |

Cost is estimated at list price and the UI says so — it knows nothing about prompt
caching, batch discounts, or a negotiated rate. A number that is roughly right beats
no number, and "what did that run cost" is the first question anyone asks about an
agent.

### What I would alert on

Four alerts, in the order I would add them.

**1. Run failure rate — page.** `agent_runs_total{outcome!="completed"}` over
`agent_runs_total`, above 10% for 10 minutes. This is the only symptom a user
actually feels: they asked a question and did not get an answer. Ten minutes because
a single bad model deploy upstream can spike it for two.

**2. Budget-exceeded rate — ticket, not a page.** `outcome="budget_exceeded"` above
5% of runs. Nothing is broken when this fires; it means the agent is running out of
road on real questions, and the fix is a prompt change, a better tool, or a higher
ceiling. It is a product signal wearing an ops costume, which is exactly why it must
not wake anyone up.

**3. p95 run duration — ticket.** `agent_steps_per_run` and
`llm_request_duration_seconds` together. A run that used to take 12s and now takes
40s is heading for the wall-clock budget, and I would rather find out from a graph
than from alert 1 firing next week. Watch the two together: more steps is an agent
problem, slower steps is a provider problem, and the pair tells you which.

**4. Tool error rate by tool — ticket.** `tool_calls_total{outcome="error"}` split by
`tool`. Per-tool because the aggregate hides the interesting case: `http_get`
failing 30% of the time is the SSRF guard doing its job on a model that keeps
picking bad URLs, while `web_search` failing 30% of the time is an outage.

What I deliberately would **not** alert on: individual tool timeouts, citation
warnings, and 429s from the rate limiter. All three are the system working. A
citation warning means the anti-hallucination check caught something — it belongs on
a dashboard where a trend is visible, not in a pager where a single event is noise.

---

## Deployment

One container. Express serves the API and the built React bundle from the same
process — see `http/static.ts` and ADR-031. The tradeoff is stated plainly there:
this is the simplest thing to deploy and demo, and a CDN in front of a static host
would be the production choice.

```
infra/Dockerfile            deps → build → runtime, on node:22-alpine, non-root
infra/containerapp.bicep    Log Analytics + environment + one Container App
infra/deploy.sh             idempotent; creates the group and registry, builds, deploys, echoes the URL
.github/workflows/ci.yml    lint → format → typecheck → test → build → image → smoke test
.github/workflows/deploy.yml  workflow_dispatch only, Azure OIDC
```

The runtime layer is built by `pnpm deploy --legacy --prod`, so the image carries the
API's production dependencies and nothing else — no pnpm store, no devDependencies,
no source, no test runner.

### Secrets

API keys are Container App **secrets** referenced by `secretRef`, never plain
environment values. They do not appear in `az containerapp show`, in a portal blade,
or in a revision's environment block. The ACR password is handled the same way.
`deploy.sh` writes them to a `chmod 600` parameter file rather than passing them on
a command line where they would land in shell history and the process table.

The keys never reach a log either: `config/secret.ts` wraps them in a type whose
`toString` and `toJSON` return `[redacted]`, and both adapters have a test asserting
the key appears in no request body and no error message.

### Scaling, honestly

`minReplicas: 0` — a demo is idle almost all of the time, and a cold start costs a
few seconds on the first request.

`maxReplicas: 2`, with **sticky sessions** on the ingress. A run lives in one
replica's memory and the browser subscribes to it in a second request; affinity is
what keeps that second request on the replica holding the run. That is a workaround,
not an architecture — the honest fix is a shared store, and it is the first thing
[the README's "what I'd do next"](../README.md#what-id-do-next) names. Two replicas
rather than twenty is the shape of that admission.

### Setting up OIDC for the deploy workflow

One-time, and there is no client secret in the repository at the end of it:

```bash
az ad app create --display-name ara-deploy
# then, on the resulting app registration, add a federated credential for
#   repo:<owner>/<repo>:environment:production
az role assignment create --role Contributor --assignee <appId> --scope /subscriptions/<subId>/resourceGroups/ara-rg
```

Then set `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`,
`ANTHROPIC_API_KEY` and `TAVILY_API_KEY` as repository secrets, and
`AZURE_RESOURCE_GROUP`, `AZURE_LOCATION`, `APP_NAME`, `ACR_NAME`, `MODEL_ID` as
repository variables.
