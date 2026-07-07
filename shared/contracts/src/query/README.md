# query — the DSL decision (Phase 0, closed)
Block queries are a DECLARATIVE JSON PIPELINE (`BlockQuery` in config/surface.ts), not a string
language. Rationale: schema-validatable (Tier-A safe for local models), compiled server-side to
store calls, and can never express what the engine wouldn't allow. A richer grammar, if ever
needed, extends `params` per source — never a parser.
