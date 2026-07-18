import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PromptTemplate } from '@openinfo/contracts'
import { WorkspaceRegistry } from '../store/index.js'
import { NEUTRAL_DIALS, compileVoiceVars, interpolateTemplate } from '../voice/index.js'
import { DistillDocuments } from './documents.js'
import { NOTHING_NOTEWORTHY, PREVIOUS_BUILTIN_BODIES, defaultDistillTemplate, defaultEntitiesTemplate, defaultExtractTemplate, defaultSummaryTemplates } from './defaults.js'

const TEMPLATE_KIND = 'prompt-template'

// The three window templates (#130) go neutral at the factory: no baked voice vector in the shipped
// body, the voice machinery still interpolates for an author who wants it, and an UNEDITED builtin left
// on an existing install refreshes to the new body — while a user edit is never clobbered.

const withStore = async (fn: (store: WorkspaceRegistry) => void | Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-distill-docs-'))
  const store = new WorkspaceRegistry(dir)
  try {
    await fn(store)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
}

// The vocabulary a re-bloated default would drag back in — dial names, the "Voice:" preamble, {{…}} dials.
const VOICE_VOCAB = /\b(tone|warmth|wit|charm|specificity|brevity|persona)\b|Voice:|\{\{\s*(tone|warmth|wit|charm|specificity|brevity|voice\.rules)\s*\}\}/i

test('a fresh install seeds the three neutral window templates (no baked voice vector)', async () => {
  await withStore((store) => {
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    for (const t of [defaultDistillTemplate, defaultExtractTemplate, defaultEntitiesTemplate]) {
      const seeded = store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, t.id)!
      assert.equal(seeded.version, 1)
      assert.doesNotMatch(seeded.body.body, VOICE_VOCAB, `${t.id} default body must carry no voice vocabulary`)
    }
  })
})

test('the rendered default distill prompt for a fresh install carries no dial vocabulary and pins the notes-voice register (#245)', async () => {
  await withStore((store) => {
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    // Render exactly as the distiller does: the neutral dial vector + the window inputs. Even with the
    // machinery supplying every dial value, none reach the prompt because the body no longer names them.
    const rendered = interpolateTemplate(docs.template().body, {
      ...compileVoiceVars(NEUTRAL_DIALS),
      windowStart: '2026-07-07T14:00:00Z',
      windowEnd: '2026-07-07T14:02:00Z',
      transcript: 'we shipped the thing',
    })
    assert.doesNotMatch(rendered, VOICE_VOCAB)
    // The #245 register is opinionated by DESIGN, not by re-bloated dials: it drops the old slop framing,
    // it explicitly BANS the transcription-narration openers, and it carries the silence sentinel.
    const body = docs.template().body
    assert.doesNotMatch(body, /tight, factual summary of what just happened/, 'the old slop framing is gone')
    assert.match(body, /the transcript indicates/i, 'the body names the banned narration framings (as prohibitions)')
    assert.match(body, /the speaker (said|expressed|stated)/i, 'the body bans the speaker-narration framings')
    assert.ok(body.includes(NOTHING_NOTEWORTHY), 'the body instructs the silence sentinel')
    // Still bounded (a re-bloat guard without depending on a since-superseded prior body): a note-taking
    // instruction is a handful of lines, never a persona essay.
    assert.ok(body.length < 1400, 'the distill body stays a tight instruction, not a re-bloated essay')
  })
})

test('the voice machinery still interpolates for a user-authored template (regression)', async () => {
  await withStore((store) => {
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    // An author edits the dial placeholders back in — the exact vector the pre-#130 default carried.
    const authored: PromptTemplate = {
      ...defaultDistillTemplate,
      id: 'tpl-distill-authored',
      builtin: false,
      body: 'Voice: tone {{tone}}/10, charm {{charm}}/10. {{voice.rules}}\n\n{{transcript}}',
    }
    docs.saveTemplate(authored)
    const stored = docs.templateById('tpl-distill-authored')!
    const rendered = interpolateTemplate(stored.body, {
      ...compileVoiceVars({ tone: 3, warmth: 4, wit: 2, charm: 2, specificity: 9, brevity: 8 }),
      transcript: 'x',
    })
    assert.match(rendered, /tone 3\/10/)
    assert.match(rendered, /charm 2\/10/)
    assert.match(rendered, /clinical/i) // {{voice.rules}} compiled from charm 2
  })
})

test('an UNEDITED builtin left from a prior install refreshes to the new neutral body (upgrade path)', async () => {
  await withStore((store) => {
    // Simulate a pre-#130 install: the old voice-baked bodies seeded at version 1.
    for (const t of [defaultDistillTemplate, defaultExtractTemplate, defaultEntitiesTemplate]) {
      store.layouts.put(TEMPLATE_KIND, t.id, { ...t, body: PREVIOUS_BUILTIN_BODIES[t.id]! })
    }
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    for (const t of [defaultDistillTemplate, defaultExtractTemplate, defaultEntitiesTemplate]) {
      const now = store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, t.id)!
      assert.equal(now.version, 2, `${t.id} refreshed (version bumped once)`)
      assert.equal(now.body.body, t.body, `${t.id} refreshed to the new neutral body`)
      assert.doesNotMatch(now.body.body, VOICE_VOCAB)
    }
  })
})

test('the refresh runs at most once — a second ensureDefaults does not re-bump', async () => {
  await withStore((store) => {
    store.layouts.put(TEMPLATE_KIND, defaultDistillTemplate.id, { ...defaultDistillTemplate, body: PREVIOUS_BUILTIN_BODIES[defaultDistillTemplate.id]! })
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    docs.ensureDefaults()
    const now = store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, defaultDistillTemplate.id)!
    assert.equal(now.version, 2, 'refreshed once, not again on the second startup')
  })
})

test('a USER-EDITED builtin is never clobbered by the refresh (version off 1)', async () => {
  await withStore((store) => {
    // A user edited the distill template: seed v1 (old body) then a v2 edit — the version is now off 1.
    store.layouts.put(TEMPLATE_KIND, defaultDistillTemplate.id, { ...defaultDistillTemplate, body: PREVIOUS_BUILTIN_BODIES[defaultDistillTemplate.id]! })
    const edited = { ...defaultDistillTemplate, body: 'MY OWN PROMPT {{transcript}}' }
    store.layouts.put(TEMPLATE_KIND, defaultDistillTemplate.id, edited)
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    const now = store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, defaultDistillTemplate.id)!
    assert.equal(now.version, 2, 'no refresh put — the user edit stands')
    assert.equal(now.body.body, 'MY OWN PROMPT {{transcript}}')
  })
})

test('a builtin whose v1 body diverges from the previous shipped body is left untouched (conservative)', async () => {
  await withStore((store) => {
    // version is still 1, but the body is NOT the known previous shipped body ⇒ do not touch.
    store.layouts.put(TEMPLATE_KIND, defaultDistillTemplate.id, { ...defaultDistillTemplate, body: 'some other v1 body {{transcript}}' })
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    const now = store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, defaultDistillTemplate.id)!
    assert.equal(now.version, 1)
    assert.equal(now.body.body, 'some other v1 body {{transcript}}')
  })
})

// #245 — the SUMMARY-family bodies (distill window notes + the five hierarchical levels) speak the human
// note-taking register: no transcription-narration framings, honesty preserved, and each hierarchical level
// still interpolates its bound placeholders. The banned framings appear in the bodies only as PROHIBITIONS.

// The narration framings the notes-voice register forbids the model from OPENING with. They legitimately
// appear inside the template bodies as the ban instruction itself, so this is a value-level, not body-level,
// guard: it is asserted against RENDERED slop in the suppression/pipeline tests, and asserted PRESENT (as a
// prohibition) in the body tests below.
const NARRATION_FRAMINGS = /the (speaker|transcript) (said|expressed|stated|indicates|shows|mentions)|it was (mentioned|noted|recorded|discussed)|the notes indicate/i

test('#245: every summary-family body drops the old slop framing and keeps the invent-nothing honesty rule', async () => {
  const distillId = defaultDistillTemplate.id
  const families = [defaultDistillTemplate, ...defaultSummaryTemplates]
  for (const t of families) {
    assert.doesNotMatch(t.body, VOICE_VOCAB, `${t.id} carries no dial vocabulary`)
    assert.doesNotMatch(t.body, /(tight, factual summary of what just happened|You are writing a|You are naming|You are distilling)/, `${t.id} drops the old report-speak framing`)
    assert.match(t.body, /invent nothing|no invented/i, `${t.id} keeps an invent-nothing honesty rule`)
    // the leading instruction reads like a note-taking directive, never a minutes preamble
    assert.match(t.body.split('\n')[0]!, /\b(jot|keep|write|name)\b/i, `${t.id} leads with a note-taking directive`)
    // only the distill window template carries the silence sentinel (the distiller is the drop point);
    // the hierarchical levels ride on suppressed distillates and are not sentinel-gated (#245 design).
    if (t.id === distillId) {
      assert.ok(t.body.includes(NOTHING_NOTEWORTHY), 'the distill body instructs the silence sentinel')
      assert.match(t.body, NARRATION_FRAMINGS, 'the distill body names the banned narration framings as prohibitions')
    }
  }
})

test('#245: an UNEDITED summary builtin left at its #177 body auto-upgrades to the notes-voice body', async () => {
  await withStore((store) => {
    for (const t of defaultSummaryTemplates) {
      store.layouts.put(TEMPLATE_KIND, t.id, { ...t, body: PREVIOUS_BUILTIN_BODIES[t.id]! })
    }
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    for (const t of defaultSummaryTemplates) {
      const now = store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, t.id)!
      assert.equal(now.version, 2, `${t.id} refreshed (version bumped once)`)
      assert.equal(now.body.body, t.body, `${t.id} refreshed to the notes-voice body`)
    }
  })
})

test('#245: a USER-EDITED summary builtin is never clobbered by the refresh', async () => {
  await withStore((store) => {
    const target = defaultSummaryTemplates[0]! // rolling
    store.layouts.put(TEMPLATE_KIND, target.id, { ...target, body: PREVIOUS_BUILTIN_BODIES[target.id]! })
    store.layouts.put(TEMPLATE_KIND, target.id, { ...target, body: 'MY OWN SUMMARY PROMPT {{children}}' })
    const docs = new DistillDocuments(store)
    docs.ensureDefaults()
    const now = store.layouts.getLatest<PromptTemplate>(TEMPLATE_KIND, target.id)!
    assert.equal(now.version, 2, 'the user edit stands — no refresh put')
    assert.equal(now.body.body, 'MY OWN SUMMARY PROMPT {{children}}')
  })
})
