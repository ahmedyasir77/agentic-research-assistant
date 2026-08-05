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
