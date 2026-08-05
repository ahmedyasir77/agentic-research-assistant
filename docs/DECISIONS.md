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
