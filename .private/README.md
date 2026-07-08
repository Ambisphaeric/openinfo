# .private/ — local machine config, never committed

This directory holds real, personal connection details for whoever is running
openinfo on their own machine: remote deploy targets, LAN IPs for fabric
endpoint boxes, API keys picked up during local testing. None of that belongs
in a public repo — it identifies your network and hardware, and in the API
key case, is a live credential.

Everything in `.private/` is gitignored **except** `*.example` files, which
are tracked as templates. The convention:

1. Tracked docs, scripts, and fixtures use obviously-fake placeholder values
   (e.g. `192.168.1.100`, `someone@192.168.1.100`, `<REDACTED>`).
2. To run something against your real setup, copy the matching `*.example`
   file, drop the `.example` suffix, and fill in real values.
3. Scripts that need real local values (e.g. `tools/redeploy-remote.sh`)
   source the matching file from here if it exists, falling back to the
   placeholder default otherwise — so the script works out of the box for a
   new clone, and picks up your real target once you add the file.

| File | Used by | Purpose |
|---|---|---|
| `redeploy.env` (from `redeploy.env.example`) | `tools/redeploy-remote.sh` | real `REMOTE_USER` / `REMOTE_HOST` for your deploy target |
| `rig.md` | you | scratch notes on your real network layout, if you want a local record |

Adding a new local-only value later: put the real file in `.private/`, add a
`*.example` sibling with a placeholder, and read it the same way.
