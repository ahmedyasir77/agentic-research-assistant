# Decisions

Short ADR-style entries: the context that forced a choice, the choice, and what it costs.

---

## ADR-001 — pnpm workspaces with a shared contracts package

**Context.** The browser and the API exchange a stream of agent events and a run trace.
If each side declares its own idea of that shape, they drift, and the drift shows up
as a runtime bug in a live demo.

**Decision.** One pnpm workspace with `packages/shared` imported by both apps. Every wire
format is a Zod schema there, and the TypeScript types are inferred from the schemas —
never hand-written alongside them.

**Consequences.** A wire format that exists in only one app is a bug, and it is a visible
one: the shared package is small enough to read in a sitting. Cost is a build step —
`@ara/shared` compiles to `dist` before either app typechecks, so the root scripts build
it first.

---

## ADR-002 — TypeScript that Node can run without a bundler

**Context.** A dev loop that needs a bundler for the backend is one more thing to explain
and one more thing to break on stage.

**Decision.** Source is ESM with explicit `.ts` import extensions, compiled with
`rewriteRelativeImportExtensions` so `tsc` emits `.js` specifiers. `erasableSyntaxOnly`
keeps the source free of runtime-bearing TypeScript syntax. `pnpm dev` runs
`node --watch src/main.ts` against Node's native type stripping; production runs plain
compiled JavaScript from `dist`.

**Consequences.** No backend bundler, no `tsx`, no extra dependency. The cost is that
enums and parameter properties are unavailable — a restriction worth having anyway.

---

## ADR-003 — Zod v4 for JSON Schema generation

**Context.** Tool arguments have to be validated at runtime *and* described to the model
as JSON Schema. Two hand-maintained descriptions of the same shape drift silently, and
the failure mode is the model confidently sending arguments the validator rejects.

**Decision.** Zod v4, whose built-in `z.toJSONSchema()` converts the same schema object
used for validation into the spec handed to the model.

**Consequences.** One definition per tool, no drift, and no dependency beyond the
stack table — Zod v3 would have required adding `zod-to-json-schema`.

---

## ADR-004 — Versioned event envelope with a sequence number

**Context.** The browser subscribes to a live event stream. Two things go wrong in
practice: a deploy ships a new event shape while an old tab is still open, and a
connection drops mid-run and re-attaches.

**Decision.** Every `AgentEvent` carries `v` (the contract version, a Zod literal
so an unknown version fails to parse rather than half-parsing) and `seq` (monotonic
per run). The trace carries its own `v` for the same reason.

**Consequences.** A stale tab detects the mismatch and can ask for a reload instead
of rendering events it half-understands, and a reconnecting client can tell what it
missed. Cost is four extra fields on the wire, which is nothing next to the payloads.

---

## ADR-005 — Secrets are a type, not a convention

**Context.** "Don't log the API key" is a rule someone eventually forgets — usually
by logging a whole config object, or interpolating a value into an error message.

**Decision.** Secret config values are wrapped in a `Secret` (`config/secret.ts`)
whose `toJSON` and `toString` both return `[redacted]`. Reading the real value
requires an explicit `.expose()`.

**Consequences.** `JSON.stringify(config)`, a pino log line, and a template literal
all redact by default — the safe path is the lazy path. Every real use of a key is
a greppable `.expose()` call, which is exactly the list a reviewer wants to audit.
This complements, rather than replaces, pino's header redaction.

---

## ADR-006 — Offline mode is enforced by config, not by discipline

**Context.** `DEMO_MODE=offline` is the insurance policy for demoing on bad wifi.
An offline run that quietly reaches the network is worse than no offline mode at
all, because it fails only when it matters.

**Decision.** `config/env.ts` rejects `DEMO_MODE=offline` combined with
`SEARCH_PROVIDER=tavily` at boot, and both provider keys are optional so the app
starts with no `.env` file at all.

**Consequences.** The offline promise is checked once, at startup, with a readable
message — not hoped for at runtime. `pnpm i && pnpm demo` works on a fresh clone
with no credentials.

---

## ADR-007 — `answer.delta` exists even though the loop emits one delta

**Context.** The `LlmClient` port is request/response, not streaming, so the final
answer arrives whole inside a validated `finish` tool call. Chunking it afterwards
to fake a typewriter would be theatre.

**Decision.** Keep `answer.delta` in the event contract, and emit exactly one delta
carrying the validated answer. The client appends deltas as they arrive.

**Consequences.** The UI is already written for streaming, so a future streaming
adapter emits more deltas with no contract change and no client change. Nothing in
the product claims to stream tokens that it does not stream.

---

## ADR-008 — Retry search and the model, but never `http_get`

**Context.** `withRetry` is generic and it is tempting to wrap every outbound call
in it. Retries are not free: they multiply load on a struggling service, and they
multiply side effects when the call is not idempotent in practice.

**Decision.** Retries are applied to the LLM call and the search provider — both are
our own dependency, both fail transiently, both are safely repeatable. `http_get`
is **not** retried.

**Consequences.** `http_get` points at an arbitrary third party the model chose. We
know nothing about that server's rate limits, its cost model, or whether the URL is
really side-effect free — a `GET` that triggers work is a bad API, but it is a
common one. Retrying it would let one agent run turn into three requests against a
stranger's server. The agent handles a failed fetch the way a person would: it is
told the fetch failed and it tries a different source.

---

## ADR-009 — The calculator is a parser, not an evaluator

**Context.** The obvious implementation of an arithmetic tool is `eval` or
`new Function`. The expression comes from a language model, and that model reads
web pages the agent fetched — so the expression is attacker-influenced input.

**Decision.** An explicit tokenizer and shunting-yard evaluator supporting
`+ - * / % ^ ( )` and unary minus. No `eval`, no `new Function`, no `node:vm`. The
ESLint config bans the first two outright.

**Consequences.** More code than a one-liner, and it is the code most worth reading:
a parser can only ever produce a number, so the worst outcome of a hostile
expression is a parse error. `node:vm` is explicitly not an answer here — it is an
isolation feature, not a security boundary. The test suite feeds it
`process.exit(0)`, `require("child_process")`, and `constructor.constructor(...)`
and asserts each one is a parse error.

---

## ADR-010 — SSRF is decided on resolved addresses, and re-decided per redirect

**Context.** `http_get` lets a model aim an HTTP request from inside our network.
A hostname-based blocklist does not work: an attacker controls what
`evil.example.com` resolves to, and a public URL can redirect to
`169.254.169.254`.

**Decision.** `platform/ssrf.ts` resolves the hostname and judges every returned
address against loopback, private, link-local, CGNAT, ULA and multicast ranges —
including IPv4-mapped IPv6 in both dotted and hex forms. If any one answer is
blocked, the request is refused. Redirects are followed by hand, one hop at a time,
with the same check on each `Location`; the HTTP client is configured with
`maxRedirects: 0` so it cannot follow one behind our back.

**Consequences.** The DNS resolver is injected, so the whole matrix — `localhost`,
`169.254.169.254`, `10.x`, a public name resolving to a private address, a
redirect into a private range — is a fast unit test with no network. The cost is a
resolution per hop and a small TOCTOU window between our lookup and the socket's;
closing that needs connection-level pinning, which is noted as future work.

---

## ADR-011 — A narrow `HttpClient` port instead of passing Axios around

**Context.** The guarded fetch needs an HTTP client. Depending on `AxiosInstance`
directly would mean every test either hits the network, adds an interceptor
library, or casts a stub to a large third-party interface.

**Decision.** `platform/httpClient.ts` defines the four fields the guarded fetch
actually uses, and adapts Axios to it in one function.

**Consequences.** A test fake is a few lines and needs no casting, which is what
made the SSRF and size-cap tests possible without `msw`. Axios stays confined to
one adapter, alongside the other two ports (`LlmClient`, `SearchProvider`) — the
same pattern in all three places.

---

## ADR-012 — Offline mode swaps transports, not guards

**Context.** The easy way to build an offline mode is to bypass the machinery: skip
the tool registry, skip validation, return a canned answer. That produces a demo
that proves nothing, and it rots, because the bypassed code is never exercised.

**Decision.** Offline replaces exactly three adapters — the LLM client, the search
provider and the HTTP transport — with fixture-backed implementations behind the
same ports. Everything else runs unchanged: the same tool registry, the same Zod
validation, the same SSRF guard, the same redirect and size limits, the same
`finish` contract.

**Consequences.** An offline run exercises essentially the whole system, so the
demo is evidence rather than theatre. There is a test asserting that `http_get`
against `169.254.169.254` is still refused *in offline mode* — the guard is not
something the fixtures get to skip. The cost is a fixture HTTP client that would
not otherwise exist; without it the recorded model turn would name a real URL and
an "offline" run would quietly reach the network, which is the failure that
matters most because it only shows up on the day of the demo.

---

## ADR-013 — One composition root, no mode checks anywhere else

**Context.** `if (offline)` scattered through the codebase is how a demo mode
becomes a second, half-tested application.

**Decision.** `apps/api/src/composition.ts` is the only file that reads
`config.demoMode`. It picks adapters and returns an `AgentRuntime`; everything
below it receives dependencies as arguments and cannot tell which mode it is in.

**Consequences.** Grepping for `demoMode` outside config and composition returning
nothing is the invariant, and it is easy to check in review. Live mode currently
*rejects* rather than falling back to fixtures until the Anthropic adapter lands in
M7 — a run that claims to be live must actually be live, and a silent fallback is
the kind of thing that makes a demo dishonest without anyone noticing.

---

## ADR-014 — Cost is an estimate, and the code says so

**Context.** `estimatedCostUsd` in the trace invites the reader to treat it as a
bill. It is not one: it knows nothing about prompt caching, batch pricing, or an
organisation's negotiated rate.

**Decision.** `llm/pricing.ts` prices tokens at published list rates from a small
table, prices the offline demo at zero, and falls back to the most expensive tier
for an unrecognised model.

**Consequences.** The number is roughly right, which beats no number — "what did
that run cost" is the first question anyone asks about an agent. Rounding an
unknown model *up* means a surprise shows up as an overstatement rather than a
silent zero.

---

## ADR-015 — The `finish` payload is not evidence for itself

**Context.** The citation check compares the URLs the agent cited against the URLs
tools returned during the run. `finish` is a tool, and its output echoes its input,
so the obvious implementation — collect URLs from every successful tool result —
adds the agent's own claimed citations to the evidence set. The check then verifies
the answer against itself: it passes every time and catches nothing.

**Decision.** `finish` is excluded from URL collection. Only tools that actually
went and got something count as evidence.

**Consequences.** This is a one-line condition guarding the project's headline
feature, and it was found by a test asserting an invented URL is marked unverified
— the check had been silently passing everything before that. The lesson is worth
keeping: a guardrail with no test proving it *fails* on bad input is not a guardrail.

---

## ADR-016 — Unverified citations are flagged, not deleted, and the prose is left alone

**Context.** When a citation cannot be accounted for, there are three options:
delete it, rewrite the answer to remove the marker, or keep both and mark it.

**Decision.** Keep the citation with `verified: false`, add a warning to the trace,
and leave the model's prose untouched. The UI distinguishes verified from stripped.

**Consequences.** Showing that the agent claimed a source and the check caught it
is more informative than a quietly shortened list — the failure is the interesting
part. Rewriting the answer to remove `[2]` was rejected: editing model prose with
string surgery risks corrupting a correct answer to hide a citation problem, and
the reader is better served by an honest marker than a doctored paragraph. The cost
is that a reader who ignores the flag sees a `[2]` with a struck-through source.

---

## ADR-017 — The loop returns its trace instead of writing one

**Context.** Something has to produce the `RunTrace` served by `GET /api/runs/:id`.
Two obvious options: have the loop write into a store it holds a reference to, or
rebuild the trace from the event stream.

**Decision.** `runAgent` is an `AsyncGenerator<AgentEvent, RunTrace>` — it yields
events as they happen and *returns* the finished trace. Callers that only want to
watch can `for await`; the run service drives it with `.next()` and keeps the
return value.

**Consequences.** The loop still owns no I/O and no storage, so it stays testable
with nothing but a fake model. Rebuilding the trace from events was rejected
because it would duplicate the bookkeeping and drift from it. There is exactly one
channel for events — an earlier `emit` side-channel was removed once the run
service turned out to need `.next()` anyway, because two paths carrying the same
events is two paths that can disagree.


---

## ADR-018 — Search fixtures are named after the query the model issues

**Context.** `fixtures/search/why-is-the-sky-blue.json` looked correct and was
unreachable. The fixture adapter resolves a file by slugifying the **search query**,
and the recorded model searches for `why is the sky blue rayleigh scattering`, not
for the user's question. The lookup fell through to `default.json`, the demo run
silently searched the wrong thing, and one of its two citations came back
`verified: false` — the guardrail working correctly on a broken fixture.

**Decision.** Search fixtures are named for the model's query
(`why-is-the-sky-blue-rayleigh-scattering.json`); LLM scripts stay named for the
user's question. `fixtures.test.ts` now resolves each script's own tool calls
through the same slug rules the adapters use, and asserts that every cited URL is
one *that script* would have seen.

**Consequences.** The two directories are keyed by different things, which is
surprising until you notice they are replacing different APIs — so the rule is
written down in `fixtures/README.md` and enforced by a test rather than by memory.
The earlier version of that test asked only whether a cited URL appeared in *some*
search fixture, which is why an unreachable file passed CI. Both bugs found in this
project so far have been a check that verified something against itself.

---

## ADR-019 — SSE with POST-then-subscribe, not WebSocket and not a streaming POST

**Context.** The browser needs to watch a run unfold. Three options: stream the
events out of the `POST /api/runs` response; open a WebSocket; or create the run
and subscribe to it separately.

**Decision.** `POST /api/runs` returns `202 { runId, eventsUrl }`, and the client
subscribes to `GET /api/runs/:id/events` as an SSE stream. Each frame carries the
event's sequence number as its SSE `id`.

**Consequences.** It costs one extra round trip and buys three things. The browser
can use `EventSource`, which reconnects on its own and re-attaches with
`Last-Event-ID` — the emitter replays only what was missed. A run is not tied to
the connection that started it, so a dropped socket does not kill work in progress.
And the run stays fetchable as a trace after it ends, which is what makes
`GET /api/runs/:id` a replay rather than a log. WebSocket was rejected because
nothing here needs a client→server channel mid-run; a duplex protocol would be
strictly more moving parts for a one-way stream. Streaming from the POST was
rejected because it makes the run's lifetime the connection's lifetime.

Frames carry no `event:` field: everything arrives on one `onmessage` handler and
is discriminated by parsing with the shared Zod union, which is one parser instead
of nine listeners that can drift from the schema.

---

## ADR-020 — Runs live in memory, with a TTL, a cap, and backpressure

**Context.** A run has to be readable after it ends, by a client that reconnects or
by someone fetching the trace. The obvious answers are a database or a cache.

**Decision.** An in-process `RunStore`: a `Map` with a 15-minute TTL and a 100-run
cap, swept on read and write rather than on a timer. Finished runs are evicted
oldest-first; runs still in flight are never evicted. When the cap is full of
in-flight runs, `POST /api/runs` returns `503` rather than accepting work it cannot
bound.

**Consequences.** No database, per the project's constraints, and no background
interval to keep the event loop alive at shutdown. What breaks at multiple
instances is explicit: a run created on instance A is a 404 on instance B, and the
per-process rate limiter counts separately on each. What would change is the
storage, not the shape — the trace is already a serialisable document and events
already carry a monotonic `seq`, so this becomes a Redis stream keyed by `runId`
with the same two operations. Refusing at capacity rather than queueing was chosen
because a queue with no durability is just a slower way to lose the work.

---

## ADR-021 — One error handler, RFC 9457, and validation by throwing

**Context.** Express error handling drifts into per-route try/catch and ad-hoc JSON
error shapes unless something stops it.

**Decision.** Every error becomes `application/problem+json` in one
`errorHandler`. Handlers never catch: they call `Schema.parse(req.body)` and let
the `ZodError` propagate — Express 5 forwards rejected promises, so the same path
covers sync and async. `ProblemError` carries status, title, type and any headers
a problem needs (`Retry-After`). `body-parser`'s two failure modes and the store's
`RunCapacityError` are mapped at that same boundary.

**Consequences.** Route handlers are three or four lines with no error plumbing,
and the client has exactly one error shape to parse. Zod validation is a call
rather than a middleware on purpose: a middleware would have to hand the parsed
value onward through `res.locals`, which is typed `any` and would put a cast into
every handler. Unrecognised errors return a deliberately uninformative 500 — the
detail goes to the log, where it helps, not to the client, where it is disclosure.

---

## ADR-022 — The rate limiter is forty lines of ours, not a dependency

**Context.** Ingress limits call for a per-IP limit on run creation.
`express-rate-limit` is the default answer and is outside the fixed stack.

**Decision.** A fixed-window limiter in `http/middleware/rateLimit.ts`: a `Map` of
address → window, swept when it grows past 10,000 entries, with the clock injected.

**Consequences.** No dependency to justify, and the behaviour is a unit test rather
than a configuration. A fixed window lets a caller burst across the boundary; with
one instance and a 10/minute default that does not matter, and the honest fix at
scale is a shared store, not a cleverer local algorithm. The key is
client-controlled, so the table is bounded — an unbounded map keyed by remote
address is a memory leak with a nice name. `trust proxy` is set to exactly one hop
(the Container Apps ingress); trusting further would let any client forge the
address it is counted against.

---

## ADR-023 — Readiness fails first, then runs drain, then the server closes

**Context.** SIGTERM arrives while agent runs are mid-flight. Killing them drops a
user's answer seconds before it arrives.

**Decision.** `shutdown()` flips a `Lifecycle` flag so `/readyz` starts returning
503, waits on every in-flight run's `whenFinished` up to 30 seconds, drops idle
keep-alive sockets, then closes the server. `/healthz` stays green throughout.

**Consequences.** The load balancer stops routing new requests while this instance
is still able to serve the ones it holds, which is the entire point of having two
health endpoints rather than one. Liveness deliberately checks nothing but the
process: a dependency being down is not a reason to have the container restarted.
The drain timeout is a bound, not a promise — a run that outlives it is abandoned
and logged, because refusing to exit is worse than losing one answer.

---

## ADR-024 — Design tokens: "the trace"

**Context.** This is a live-updating view of machine reasoning, so the timeline is
the signature element and everything else should stay quiet. Three looks were
deliberately avoided because they are what everything built in 2026 looks like:
cream background with a serif display face and a terracotta accent; near-black with
a single acid accent; and the hairline-rule broadsheet grid.

**Decision.** One continuous vertical rule runs down the left of the page — the
trace — and the run advances along it. Step cards hang off the trace to the right;
the segment behind the run's head is drawn in `--signal`, the segment ahead is not
drawn at all, so the line grows as the agent works. The answer docks at the bottom
as the trace's terminus, and a failure terminates it in `--flag` instead. The
composer sits at the top, where the trace starts.

*A run is a signal advancing through time, so the interface is built around the
shape a logic analyser draws — which also makes "it is still going" legible from
across a room, without an animation.*

**Six values.** Cool greys with blue in them, not neutral and not warm:

| Token | Hex | Used for |
| --- | --- | --- |
| `--ink` | `#16202B` | Body text and the drawn trace |
| `--muted` | `#5D6E7E` | Labels, timings, step numbers |
| `--paper` | `#E8ECF0` | Page background |
| `--card` | `#FCFDFE` | Step cards and the answer pane |
| `--signal` | `#0B69C7` | Live: the trace's head, running counters, links |
| `--flag` | `#B0362A` | Failures, refused calls, unverified citations |

Note what is *not* here: a separate "success" green. Verified and unverified
citations are distinguished by treatment — a solid underline against a dashed rule
and a flag glyph — not by colour alone, so the anti-hallucination check reads the
same to someone who cannot tell the two apart.

**Two typefaces, both already on the machine.**

- **Instrument** — `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas,
  monospace`. Headings, step numbers, tool names, counters, and every raw payload.
- **Voice** — `ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial`.
  Used in exactly two places: the model's reasoning text, and the final answer.

**Consequences.** The usual hierarchy is inverted — the monospace is the display
face and the proportional face is the restrained one — so you can tell the
instrument from the argument at a glance, and the two moments where the machine
is actually addressing a person stand out by being the only prose on the page.
Character comes from weight, tracking and case rather than from a novelty face,
which matters because **no webfont is loaded**: a Google Fonts link would make the
offline demo issue a network request, and the one promise `DEMO_MODE=offline` makes
is that it does not. The cost is that the display face is whatever monospace the
viewer has, so the page looks slightly different on Windows than on macOS.

---

## ADR-025 — `GET /api/config`, and why the offline indicator is not a switch

**Context.** The UI needs to show, from the moment it loads, that a run is offline
— that is the point of the offline mode, and on stage it is the thing worth
pointing at. It also needs the event schema version, which `events.ts` was already
written to expect the client to check.

**Decision.** One endpoint, `GET /api/config`, returning `{ demoMode, modelId,
eventSchemaVersion }`. The UI renders the mode as a status indicator, not a toggle.

**Consequences.** The brief asked for a toggle; this is a label instead, and that
is a deliberate departure. `DEMO_MODE` is a server-side environment variable read
once at boot: a switch in the browser could not change it, and a switch that
silently does nothing is worse than a label that is true. Making it real would mean
letting an unauthenticated client choose to spend money on model calls, which is a
different feature with different requirements. `pnpm demo` remains the way to
choose the mode, and the badge tells you which one you got. The version field earns
the endpoint on its own: a browser tab left open across a deploy can now say
"reload" rather than quietly dropping events it does not understand.

---

## ADR-026 — The vendor adapters are Axios, not vendor SDKs

**Context.** M7 needs the Anthropic Messages API and the Tavily search API.
`@anthropic-ai/sdk` is the obvious choice for the first, and it is outside the
fixed stack in §2.

**Decision.** Both adapters are built on Axios through a `JsonPoster` port —
`platform/jsonPost.ts` — with the wire shapes parsed by Zod at the boundary. No
new dependency.

**Consequences.** The retry, timeout and abort behaviour comes from the platform
primitives already written in M2 rather than from a second, differently-configured
mechanism inside an SDK — one backoff policy, one place to change it. The vendor
types stop at one file each, which is what the `LlmClient` and `SearchProvider`
ports were for. The cost is real: the request and response shapes are hand-mapped
and hand-validated, so a change to the Messages API is a change here rather than a
dependency bump, and none of the SDK's conveniences (streaming helpers, the tool
runner, typed betas) are available. That trade is worth it for a project whose
point is that the seams are visible, and it keeps `pnpm why` honest. Revisit if
streaming responses are added — that is where writing it by hand stops being cheap.

---

## ADR-027 — Blocks the adapter does not understand are carried, not dropped

**Context.** Extended thinking is on by default on current models. A response
comes back containing `thinking` blocks, and the API **rejects the next turn** if
those blocks were dropped or edited on the way back. The port's normalised block
union knew only `text`, `tool_use` and `tool_result`, so a live multi-turn tool
loop would have failed on step two.

**Decision.** One more block in the port: `{ type: 'opaque', vendor }`. The adapter
maps any vendor block it does not recognise into it verbatim, and maps it straight
back out when serialising the conversation. Nothing above the port ever looks
inside — `assistantText` and `toolUses` filter by type and simply skip it.

**Consequences.** Thinking round-trips byte-for-byte, and so does any block type a
vendor adds later: an unfamiliar block cannot take a run down. The port stays
vendor-neutral in the sense that matters — nothing above it knows what the payload
means — while being honest that some of the conversation is not ours to interpret.
The alternative, sending `thinking: {type: 'disabled'}`, was rejected on two
counts: it is model-specific (rejected outright on some models, effort-gated on
others) and `MODEL_ID` is a deployment choice, so the adapter must work for
whatever it is set to; and turning off reasoning on a reasoning task to avoid
writing fifteen lines is the wrong trade. For the same reason no `thinking`
parameter is sent at all — each model is left to its own default.

---

## ADR-028 — A wrapped provider error is still classifiable

**Context.** The adapters wrap provider failures in `LlmError` and
`SearchProviderError` so the layers above see one type. But `withRetry` decides
what to retry by reading `status` and `Retry-After` off the error, and wrapping hid
both — every provider 429 would have been treated as permanent.

**Decision.** The adapters put the provider's status on the error they raise, and
`platform/transient.ts` looks one level down into `cause` when the error it is
handed carries no facts of its own.

**Consequences.** A 429 or a 503 from either provider is retried with the existing
full-jitter backoff and honours `Retry-After`; a 400 fails once, immediately.
Wrapping stays free — an adapter can raise its own error type without silently
disabling the retry policy — and both adapters have a test asserting exactly that
distinction, because it is the kind of thing that breaks quietly.

---

## ADR-029 — `finish` accepts an answer with no citations

**Context.** `citations` was a required field on the `finish` tool. The first live
run to ask a question answerable by arithmetic — "how many times more strongly does
air scatter 450nm light than 700nm light" — produced the correct answer, called
`finish` without a `citations` key, was rejected for invalid arguments, and did it
again four times before the run ended as `no_tool_call` with the answer in hand.

**Decision.** `citations` defaults to `[]`, and the description tells the model to
omit it when the answer rests on no source.

**Consequences.** An answer that needed no sources can now be given. The
anti-hallucination check is untouched — it verifies the claims that are made, and
an empty list makes no claims. Requiring the field never forced a real citation
anyway: `[]` always satisfied it, so the requirement only ever caught models that
omitted the key rather than models that skipped the work.

Two things are worth keeping from how this was found. The guardrails behaved
exactly as designed under real conditions — invalid arguments came back as a
readable tool error, the model got to retry, and the nudge-then-stop rule ended the
run instead of looping forever. And no offline test could have caught it, because
the recorded fixtures always send a well-formed `finish`: a schema is a contract
with a model, and only a real model tells you whether the contract is reasonable.

---

## ADR-030 — A turn that called no tool is still a step, and is not a warning

**Context.** Two things showed up in live use that no offline test had. Asking
"what is the capital of France?" made the model answer in prose — reasonably, since
no research was needed — which triggered the nudge. The run then completed
correctly, but reported `steps: 1` in its trace while the event stream had emitted
two `agent.step.started` events, and the UI showed the successful run under the
heading "The run flagged an issue".

**Decision.** Three changes. The nudged turn is recorded with `addStep` like any
other, with its text and an empty tool-call list. The `missing_finish_call` warning
moves from the nudge to the failure that follows an ignored nudge. And the system
prompt now says that `finish` is required even when the question needed no
research.

**Consequences.** The trace and the event stream agree about how long a run was —
they describe the same run and a reader will compare them, so a disagreement is a
bug however harmless it looks. A warning now means one thing: *the answer is less
trustworthy than it appears*. A model that was corrected once and complied cost a
step, which the trace shows plainly; it did not change the answer, so it is not a
warning. After the prompt change the same question goes straight to `finish` in a
single step and never triggers the nudge at all — the nudge is back to being the
guardrail it was meant to be rather than a routine event.

Extracting `complete`, `fail` and `recordStep` into `agent/outcome.ts` while making
this change brought `loop.ts` to 143 lines: the loop now decides *whether* to stop,
and one other file does the bookkeeping of stopping.

---

## ADR-031 — One container: Express serves the React bundle

**Context.** The UI is a static bundle and the API is a Node process. The textbook
production answer is a CDN in front of object storage for the first and a container
for the second. That is two things to deploy, two things to configure CORS between,
and two things that can be at different versions during a rollout.

**Decision.** In production, Express serves `apps/web/dist` from the same process
that serves `/api`, via `http/static.ts`. `WEB_DIR` points at the bundle; when there
is no bundle there — the development arrangement, where Vite serves the UI on its
own port — the API mounts nothing and serves only JSON.

**Consequences.** One image, one revision, one URL, no CORS, and the front end and
back end cannot be at different versions because they ship as one artifact. The UI
also gets whatever the API's ingress gets for free.

The cost is honest and worth saying out loud in an interview: static bytes are being
served by a Node process that could be doing something else, cache headers are hand
written rather than a CDN's, and a UI-only change requires a full deploy. At this
size none of that is measurable. At real traffic, the bundle moves to a CDN and this
router is deleted — which is why it is one small file with no dependencies on the
rest of the app.

Two routing details are load-bearing. The static router is mounted **after** every
API router, so no path the API owns can be answered with HTML. And the single-page
fallback explicitly excludes `/api/`, because otherwise a fetch to a mistyped
endpoint would receive `200` and an HTML page, and fail at `JSON.parse` with no clue
why — instead of the `problem+json` 404 every other error in this app produces.

---

## ADR-032 — `pnpm deploy --legacy` for the runtime layer

**Context.** The runtime image should carry the API's production dependencies and
nothing else: no pnpm store, no devDependencies, no source, no test runner. `pnpm
deploy` produces exactly that — a self-contained directory with a real
`node_modules` and the workspace dependency (`@ara/shared`) copied in rather than
symlinked out of a tree that will not exist.

From pnpm 10, plain `pnpm deploy` refuses to run unless the workspace sets
`inject-workspace-packages=true`, which changes how workspace packages are linked
during ordinary development too.

**Decision.** `pnpm deploy --legacy --prod`, and `"files": ["dist"]` in the API's
`package.json` so the copy excludes source, tests and coverage output.

**Consequences.** The development loop is untouched — `pnpm build:shared` still
writes a `dist` that the API sees immediately, which injected packages would have
complicated for no gain here. The flag is a deprecation risk, and the mitigation is
that CI builds the real image on every pull request, so the day it stops working is
the day a PR goes red rather than the day a deploy fails.

---

## ADR-033 — `.dockerignore` at the repository root, not beside the Dockerfile

**Context.** The layout puts the Dockerfile in `infra/`, so the ignore file "should"
live there too. It cannot. Docker reads `.dockerignore` from the **build context**
root, and the context is the repository root because the Dockerfile copies from
`packages/` and `apps/`. BuildKit will also read `infra/Dockerfile.dockerignore` —
but `az acr build`, which is how `deploy.sh` builds the image without a local Docker
daemon, will not.

**Decision.** One `.dockerignore` at the repository root, with a comment at the top
saying why it is not in `infra/`.

**Consequences.** Every builder honours it, including the one the deploy script
actually uses. The alternative would have been a file that looks correct, sits in the
tidy location, and silently does nothing — uploading `node_modules` on every build
and leaving someone to work out why the context is 400 MB. A misplaced ignore file
fails quietly, which is the worst way for infrastructure to fail.

---

## ADR-034 — Registry credentials as a container app secret, not a managed identity

**Context.** The container app has to authenticate to ACR to pull its image. The
better answer is a system-assigned managed identity with an `AcrPull` role
assignment: no password exists, so no password can leak or need rotating.

It also needs the identity to exist before the role assignment, and the role
assignment to exist before the first image pull — a two-phase deployment — and the
deploying principal needs `User Access Administrator` or `Owner` to create a role
assignment at all, which `Contributor` is not.

**Decision.** The ACR admin credential, stored as a container app **secret** and
referenced by `passwordSecretRef`. `deploy.sh` reads it from `az acr credential
show` and writes it into a `chmod 600` parameter file rather than passing it on a
command line, where it would land in shell history and the process table.

**Consequences.** One `az deployment group create` deploys the whole thing, from a
principal with only `Contributor`, and it is idempotent. The API keys are handled the
same way — `secretRef`, never a plain environment value — so nothing sensitive
appears in `az containerapp show` or a portal blade.

What this costs is a long-lived shared credential that rotation has to remember. It
is the first item on the deployment half of "what I'd do next", and the honest
framing in an interview is: I know what the right answer is, I know exactly why I did
not do it, and the fix is a role assignment plus a second deployment phase.

---

## ADR-035 — `minmax(0, 1fr)` on the tool-call grid

**Context.** Taking the README screenshot showed the page scrolling sideways.
Measured rather than guessed: `document.body.scrollWidth` was **9122** against a
1100-pixel viewport. The cause was the `finish` call's one-line argument summary —
the whole answer, serialised — in a grid track sized by the implicit `auto`, which
has a min-content floor. The track stretched to fit the text, the card stretched with
it, and the ellipsis on `.call__args` could never engage because nothing was ever too
narrow.

**Decision.** `grid-template-columns: minmax(0, 1fr)` on `.calls`.

**Consequences.** The summary truncates as it was always meant to, the timing stays
inside the card, and the page fits its viewport. This is the second bug of exactly
this shape — the first was the expanded payload needing `pre-wrap` — and both share a
root cause worth naming: **a model writes text of a length no designer would type.**
Anything that renders model output needs a stated wrapping or truncation behaviour,
and "it looked fine with the fixture I had" is not one.

It is also the second time a bug was found by looking at the running app rather than
by running the tests. jsdom has no layout engine, so no unit test in this repository
could have caught it. The check that did catch it was a screenshot.
