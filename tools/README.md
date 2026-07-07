# tools — dev-only
- `schema-gen/` — TS types → JSON Schema into shared/contracts/schemas (the Rust-portable artifact)
- `bench/` — endpoint benchmark harness; writes measured tok/s into fabric via the API
- `fixtures/` — capture recorder/replayer: record a real meeting once, replay it into the
  engine deterministically. THE key tool: makes distill/extract/voice work testable without
  sitting in meetings, and turns dogfood findings into regression tests.
