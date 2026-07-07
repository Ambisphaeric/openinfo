---
name: add-a-block
description: Add a new block to one of your surfaces (HUD, workbench) by editing its surface document. Use when the user wants a new panel section, a pinned doc card, or a custom query view.
---

# Add a block

1. Fetch the target surface document: `GET /layouts/surfaces/{id}`.
2. Choose a block type from `GET /contracts/block-types` (built-ins) — prefer built-ins over custom.
3. Compose the block object; validate it against `GET /contracts/Block` (JSON Schema) BEFORE writing.
4. Insert into `stack` at the position the user asked for; set `show`, `top`, `collapsed` explicitly.
5. `PUT /layouts/surfaces/{id}` — the engine revalidates; on 422 read the error, fix, retry once.
6. Tell the user the flag key if the block type is flagged, and how to revert (documents are versioned;
   `POST /layouts/surfaces/{id}/rollback`).

Never: edit application code for a block addition; invent block types; write a document that fails validation.
