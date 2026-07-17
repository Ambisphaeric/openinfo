/**
 * ECHO-BLEED FIXTURES — the deterministic tuning corpus for EchoDedupe (follow-up to #151).
 *
 * The #151 dedupe caught CLEAN mic echoes (loud playback bleeds the far side onto the mic, the STT
 * transcribes it near-identically → Jaccard ≥ 0.8 or full mic⊆system containment). The reported miss is
 * the GARBLED loud-bleed twin: at high playback volume the mic pickup of the speaker transcribes
 * IMPERFECTLY (substituted / split / dropped words), so token overlap falls below the 0.8 bar and the
 * phantom `mic · me` row survives. These cases model that regime with realistic garble, alongside the
 * genuine-dialogue negatives that MUST NOT be swept up (eating real user speech is worse than leaving a
 * phantom row — the false-positive floor is the hard constraint).
 *
 * Pure data (no engine/model imports) so the corpus drives a unit test AND documents the before/after
 * miss/false-positive table in one place. `deltaMs` is `capturedAt(mic) − capturedAt(system)` and is
 * always ≥ 0: acoustic bleed LAGS the playback it copies (the speaker plays, then the mic hears it), so a
 * bled twin is captured at or after its system twin — never before.
 */
export interface EchoBleedCase {
  /** Stable case name for the test row + the tuning table. */
  name: string
  /** The clean far-side (system-audio) line already primed into the rolling buffer. */
  system: string
  /** The mic fragment under test — either a bled twin of `system` or genuine user speech. */
  mic: string
  /** capturedAt(mic) − capturedAt(system), ms (≥ 0: bleed lags playback). */
  deltaMs: number
  /** true ⇒ speaker-bleed twin that SHOULD be dropped; false ⇒ genuine speech that MUST be kept. */
  expectEcho: boolean
  /** Why this case is labelled as it is — the tuning rationale. */
  note: string
}

export const ECHO_BLEED_FIXTURES: readonly EchoBleedCase[] = [
  // --- GARBLED loud-bleed twins: SHOULD drop, but MISSED by the #151 Jaccard-0.8 / containment rule ---
  {
    name: 'garble/substituted-and-split-words',
    system: 'we should ship the release on thursday afternoon',
    mic: 'we shall ship the leash on thursday after noon',
    deltaMs: 400,
    expectEcho: true,
    note: 'loud bleed: should→shall, release→leash, afternoon split into "after noon". Jaccard 5/12≈0.42 (< 0.8, missed on main); mic-coverage 5/9≈0.56 within 750ms is a bleed signature.',
  },
  {
    name: 'garble/singular-plural-drift',
    system: 'let us circle back on the budget numbers tomorrow',
    mic: 'let us circle back on the budge number tomorrow',
    deltaMs: 300,
    expectEcho: true,
    note: 'budget→budge, numbers→number. Jaccard 7/11≈0.64 (< 0.8, missed on main); mic-coverage 7/9≈0.78.',
  },
  {
    name: 'garble/dropped-and-fused-words',
    system: 'can everyone please mute their microphones during the demo',
    mic: 'can everyone mute there microphone during demo',
    deltaMs: 500,
    expectEcho: true,
    note: 'dropped "please/their", their→there, microphones→microphone, dropped "the". Jaccard 5/12≈0.42 (missed on main); mic-coverage 5/7≈0.71.',
  },
  // --- Genuine speech / dialogue: MUST be kept (the false-positive floor) ---
  {
    name: 'genuine/topical-overlap-not-simultaneous',
    system: 'the quarterly numbers look strong overall this year',
    mic: 'our quarterly numbers were down a bit last year',
    deltaMs: 400,
    expectEcho: false,
    note: 'both parties discuss the quarter; shares quarterly/numbers/year only. mic-coverage 3/9≈0.33 (< 0.5) — genuine, kept even inside the tight window.',
  },
  {
    name: 'genuine/short-backchannel-agreement',
    system: 'so we will go with the blue design then',
    mic: 'yeah the blue one works for me honestly',
    deltaMs: 300,
    expectEcho: false,
    note: 'genuine agreement echoing two words (the/blue). mic-coverage 2/8=0.25 — kept.',
  },
  {
    name: 'genuine/confirmation-heavy-overlap-but-late',
    system: 'move the invoice to next quarter',
    mic: 'okay moving the invoice to next quarter now',
    deltaMs: 1500,
    expectEcho: false,
    note: 'genuine spoken confirmation 1.5s AFTER the far side — heavy overlap (mic-coverage 5/8≈0.63) but NOT near-simultaneous, so beyond the 750ms tight window and below the 0.8 confident bar → kept. Proves the tight window is load-bearing.',
  },
  {
    name: 'genuine/short-fragment-high-overlap-under-floor',
    system: 'the meeting is at three today downtown',
    mic: 'meeting at three maybe',
    deltaMs: 300,
    expectEcho: false,
    note: 'only 4 unique mic tokens (< the 5-token garble-tier floor); high coverage 3/4 but too short to relax the bar on → kept. Proves the higher min-token floor on the relaxed tier.',
  },
  {
    name: 'genuine/long-utterance-containing-bled-phrase',
    system: 'move the meeting',
    mic: 'i said we should move the meeting earlier maybe next week',
    deltaMs: 500,
    expectEcho: false,
    note: 'user speech that HAPPENS to contain a short far-side phrase — directional coverage 3/11≈0.27 keeps it (the reverse-containment guard the tier must not break).',
  },
]
