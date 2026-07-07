# engine/index — Phase 2 (v0), Phase 3 (full)
The context index.
- `extract.ts` (P2) — entities from the distill pass (people/artifacts/topics), pointers to moments
- `rank.ts` (P2) — score = match × recency × frequency × person-affinity
- `canon.ts` (P3) — reference merging; outbound-use outranks viewed
- `ingest/` (P3) — pin fetchers: pdf.ts first, gdoc.ts behind auth flag; chunk with page anchors
