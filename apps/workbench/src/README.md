# workbench — Phase 4 (served by the authenticated engine)

Browser access requires an engine browser-session cookie. Local native clients bootstrap it with a
one-use Settings ticket; cross-machine access additionally requires the trusted HTTPS tunnel and a
provisioned client credential path, which is not product-wired yet. Direct plaintext LAN access is refused.

- `ledger/` — full commitment list + action cards (HUD shows top-K, links here)
- `archive/` — session history, distillates, moments
- `brief/` — pre-meeting brief (HUD state C logic rendered large)
- `explore/` (P6) — infinite canvas, lenses, vector-recall branches (rabbithole pattern)
- `analytics/` (P7) — backlog depth chart, drain ETA, queue table
