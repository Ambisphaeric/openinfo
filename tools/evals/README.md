# tools/evals — per-tier quality scoring (Phase-0-adjacent, per docs/DESIGN-CRITIQUE.md §1)
Golden fixtures (from tools/fixtures) scored per capability tier (T0–T3) on local runtimes (mlx):
extraction F1, register-detection error, compression fidelity, tokens/pass. THE benchmark of the
workflow engine's utility; PRs touching prompt templates must show the eval delta.
