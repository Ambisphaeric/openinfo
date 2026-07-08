# skills — shipped customization recipes

Agent skills (`SKILL.md` format — YAML frontmatter `name` + `description`, then the recipe body, per the
agentskills.io / Claude-Code convention) that ship WITH the application so any capable model — including a
local qwen3-30b-a3b or 8b — can walk a user through customization safely. Each skill is a recipe over
DOCUMENTS only: it edits schema-validated documents through the API, or follows a CONTRIBUTING.md recipe
for the (rare) code case. A wrong document cannot ship (JSON-Schema validation is the gate), which is what
makes these safe for small models — see the Tier-A row in CONTRIBUTING.md.

**Shipped:** `add-a-block` (splice a block into a surface document). See it for the pattern.

**Planned (not yet written):** new-register · new-template-app · pin-and-ingest · add-a-flag ·
design-a-palette · wire-a-fabric-endpoint.
