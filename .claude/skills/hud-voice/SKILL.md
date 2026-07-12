---
name: hud-voice
description: "Human-oriented communication and calm-display rules for every openinfo surface — panels, pills, chips, notes, tooltips, errors. Use when designing, building, reviewing, or wording ANY user-facing surface, state, or interaction: it governs how a surface speaks and behaves (language, honesty, glanceability, degraded states), regardless of what data it composes. Pair with ui-ux-pro-max for visual-system decisions."
---

# hud-voice — how openinfo surfaces speak to a human

openinfo surfaces are **declared compositions of primitives** (transcript, distillates,
moments, entities, session clock, screen context, …) rendered by one generic engine —
composable templates, unopinionated; different composable patterns for different folks.
This skill does not decide *what* a panel composes. It decides **how any composition
communicates**: as a calm, human, glanceable teammate — never as a machine printing its
internals.

## 1. Calm technology (the display posture)

An openinfo surface lives in the user's periphery during real work. Apply Amber Case's
calm-technology principles literally:

- **Smallest sufficient attention.** A surface earns the user's fovea only for what they
  would act on. Everything else stays glanceable: short, stable, low-churn.
- **Inform without demanding.** No element may block, bounce, flash, or grow to force
  attention. New information arrives in place; the user chooses when to look.
- **Use the periphery.** Prefer persistent low-detail signals (a chip, a count, a dot)
  over transient high-detail ones (toasts, modals). Detail is something the user opens.
- **Amplify, don't replace.** Copy speaks about the *user's* world ("Sarah mentioned the
  Q3 deadline"), not about the system's world ("distillate stored").
- **Work even when failing.** A degraded surface must still be useful and must say, in
  calm human words, what it still knows and what it's missing. See §3.

## 2. Language: human words, banned machine-speak

Display layers carry ZERO internal vocabulary. If a term names our implementation, it
does not render. This extends the standing rule that removed model names from the HUD.

| Never render | Render instead |
|---|---|
| model/endpoint/slot names, ids (`ses-…`, `surf-…`) | nothing, or the human thing it belongs to |
| "inference", "invoking", "pipeline", "distillate" | "thinking", "catching up", "summary" |
| "confidence 0.62", raw scores | "not sure", "probably", or omit |
| "transcript ring", "session", "workspace" (as jargon) | "what's been said", the workspace's *name* |
| "egress denied", "endpoint unreachable" | "stays on this Mac", "can't reach your model right now" |
| stack traces, HTTP codes, JSON fragments | one calm sentence; detail behind a disclosure |
| "ERROR", "FAILED" in headline position | say what happened and what still works |

Voice rules: active voice, present tense, second person where natural. One idea per
element. Sentence case, no exclamation points, no apologies, no anthropomorphic drama.
Numbers get human framing ("about 20 minutes", not "1183s"). Timestamps are relative
("just now", "3 min ago") until the user opens detail.

## 3. Honest states (every surface ships all of these)

A surface is not done when the happy path renders. Every composition declares how it
shows each state, in calm human words — never fake freshness, never silent blanks:

- **Empty** (nothing yet): say what will appear and what, if anything, the user can do.
  "Nothing captured yet — start listening to see the conversation here."
- **Loading / catching up**: name the wait honestly, without spinners-forever.
  "Catching up on the last few minutes…"
- **Degraded** (a source unavailable): the surface keeps working on what it has and
  names the gap once, quietly. "Screen context is off — no vision model connected."
- **Stale**: aged data says its age; it never impersonates live data.
- **Failed**: one human sentence + a reachable path to the real reason (disclosure,
  diagnostics link). A disabled control must say the TRUE current reason it is disabled,
  and every failure path must remain reachable in the UI — an error painted where the
  user can never navigate is dead code (the 0.0.15 Ask lesson).

## 4. Glanceable → detail (progressive disclosure)

Structure every panel as a ladder, per Apple HIG widget/menu-bar guidance:

1. **Glance** (≤1s): the single most decision-relevant fact, stable position, stable size.
2. **Look** (~5s): the composed summary — topic, who, how long, what changed.
3. **Open** (deliberate): full detail, provenance, correction affordances.

Rungs never leak downward: raw detail (full transcripts, source lists, provenance) is
never in glance position. Hierarchy comes from type scale and spacing, not boxes-in-boxes.
Motion is functional only (state change, height change) — never decorative loops.

## 5. Feedback is part of the composition

Surfaced data may be wrong, and the system learns from corrections. Any element that
asserts something about the user's world (a name, a topic, an entity, a summary line)
should accept lightweight feedback — 👍/👎 or an edit — without leaving the panel, and
the correction visibly takes effect. Never make the user feel corrected data was ignored.

## 6. The sane-defaults gate (review checklist)

Before any surface slice ships, answer as the OWNER, ten seconds after a fresh install:

- [ ] Does the default entry point (⌘\, tray) actually reach this?
- [ ] Is every visible word human (§2)? Read every string aloud; would you say it to a
      colleague?
- [ ] Kill the engine / remove a model / cold-boot the race: does every affordance either
      recover on its own or explain itself in reachable UI (§3)?
- [ ] Is the glance rung stable while data churns underneath (§4)?
- [ ] Do disabled things say why, truthfully, right now?

A green driven e2e proves the mechanism; this gate proves a stranger would understand it.
Both are required.
