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
