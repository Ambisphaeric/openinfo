import type { Flag } from '@openinfo/contracts'
import { escapeHtml, jsonForScript, type SetupData } from '../../setup/view.js'

/**
 * The Features section — the vision-critical piece: every capability must be enable/disable-able
 * in any combination, from a surface, without env edits. Every seeded feature flag is
 * rendered as a human-named toggle with a description, grouped by pipeline stage, showing its current
 * value and its dependencies. Flipping a toggle composes the EXISTING PUT /flags/:key route (the same
 * one the Try-it consent-flip already uses) — no new engine capability, per the P6 "forms over
 * documents" rule. Pure and node-tested; the interactive behaviour is FEATURES_SCRIPT below.
 *
 * The six real gating flags (distill.enabled / distill.transcribe / distill.moments / distill.index /
 * act.enabled / route.detect) are ALREADY seeded documents — they live in
 * shared/contracts/examples/flag.examples.json and are loaded by ensureDefaultFlags, so GET /flags
 * enumerates them all. (The research doc's "4 of 6 unseeded" claim traced to a stale, unused
 * apps/engine/src/flags/defaults.ts — since removed — that listed only capture.sim/fabric.http; the live
 * seeding source has always been the contracts examples file loaded by ensureDefaultFlags.)
 */

/** Ordered pipeline stages — the human's mental model of the drain, capture → act, plus a catch-all. */
const STAGES = ['Capture', 'Distill', 'Extraction', 'Index', 'Act', 'Router', 'Other'] as const
type Stage = (typeof STAGES)[number]

/** One-line honest sense of what a stage owns, shown under its heading. */
const STAGE_NOTE: Record<Stage, string> = {
  Capture: 'what openinfo takes in.',
  Distill: 'turning raw capture into distillates via the llm slot.',
  Extraction: 'pulling typed moments out of what was distilled.',
  Index: 'building the entity index over what was distilled.',
  Act: 'what openinfo prepares for you off a finished session.',
  Router: 'noticing what you are working on and routing sessions.',
  Other: 'everything else — surface, ingestion, and dev toggles.',
}

interface FeatureMeta {
  /** human name — a capability, not a flag key */
  label: string
  stage: Stage
  /** other flag keys this one needs to be ON to do anything */
  depends?: string[]
  /** honest one-liner: what turning it on does, and any caveat */
  note: string
}

/**
 * Presentation registry keyed by flag key — human names + stage + dependencies + honest notes. This is
 * pure presentation metadata (NOT a contract field): the Flag document carries only key/default/scope/
 * description/minTier, so adding human copy here keeps the schema untouched (additive, no engine change).
 * A flag NOT listed here still renders (under Other, humanized key + its own description) — GET /flags
 * drives the section, so a forward/hand-set flag is never invisible.
 */
const FEATURE_META: Record<string, FeatureMeta> = {
  'capture.camera': {
    label: 'Camera presence',
    stage: 'Capture',
    note: 'Presence / away detection from the camera. Present-but-future — the camera source is not wired yet.',
  },
  'capture.sim': {
    label: 'Headless capture simulator',
    stage: 'Capture',
    note: 'Feeds synthetic capture chunks so the client↔engine seam can be proven without a mic. Dev/test only.',
  },
  'distill.enabled': {
    label: 'Distill what is captured',
    stage: 'Distill',
    note: 'The rolling-merge distiller: windows capture, interpolates the active voice, calls the llm slot, persists a distillate. Nothing downstream runs without this.',
  },
  'distill.transcribe': {
    label: 'Transcribe audio (speech → text)',
    stage: 'Distill',
    depends: ['distill.enabled'],
    note: 'Rewrites captured audio to text via the stt slot before the distill pass. Needs a Hearing (stt) endpoint configured.',
  },
  'distill.moments': {
    label: 'Extract typed moments',
    stage: 'Extraction',
    depends: ['distill.enabled'],
    note: 'Pulls commitments ●, questions ◆, decisions ▲ and artifacts ✱ out of each distilled window.',
  },
  'distill.index': {
    label: 'Build the entity index',
    stage: 'Index',
    depends: ['distill.enabled'],
    note: 'Extracts entities and ranks them by recency × frequency. Linking moments to entities also needs "Extract typed moments".',
  },
  'summaries.enabled': {
    label: 'Build a summary timeline',
    stage: 'Distill',
    depends: ['distill.enabled'],
    note: 'Rolls the distillates up into a rolling and five-minute view during the session, and a durable session summary at the end. Each summary points back to its sources; the prose is a proposal, and if the summarizing model is unavailable the entry says so rather than inventing one.',
  },
  'act.enabled': {
    label: 'Prepare a follow-up draft',
    stage: 'Act',
    depends: ['distill.enabled'],
    note: 'On session end, composes a follow-up draft from the session’s distillates + moments (prepared, never sent). Needs distillates to draft anything.',
  },
  'route.detect': {
    label: 'Detect what I am working on',
    stage: 'Router',
    note: 'Focus signals (window title + repo path) feed the router, which auto-starts/switches sessions into the matched workspace. Independent of distillation — focus is context, not content.',
  },
  'fabric.http': {
    label: 'HTTP endpoint health & benchmarks',
    stage: 'Other',
    note: 'Enables reachability, latency and tok/s checks against http endpoints.',
  },
  'surface.block.pinned-doc': {
    label: 'Pinned-doc HUD block',
    stage: 'Other',
    note: 'An always-visible pinned-doc card with a copy bar on the HUD. Renders the hydrated pin (title + ingest state) from the pins store, with the configured reference as its empty-state fallback.',
  },
  'voice.drift': {
    label: 'Voice register drift',
    stage: 'Other',
    note: 'Register comparator + escalation chains (how the voice adapts across a session). Present-but-future.',
  },
  'ingest.gdoc': {
    label: 'Google Docs ingestion',
    stage: 'Other',
    note: 'Read-only ingestion of pinned Google Docs. Present-but-future — the ingestion path is not wired yet.',
  },
}

/** Humanize an unregistered flag key ("surface.block.pinned-doc" → "surface block pinned doc"). */
const humanizeKey = (key: string): string => key.replace(/[.-]/g, ' ')

/** Resolve presentation metadata for a flag, synthesizing an Other-stage entry when unregistered. */
const metaFor = (flag: Flag): FeatureMeta =>
  FEATURE_META[flag.key] ?? { label: humanizeKey(flag.key), stage: 'Other', note: flag.description }

const isOn = (flags: Flag[], key: string): boolean => flags.some((f) => f.key === key && f.default === true)

/** The dependency line: names each required flag and whether it is currently satisfied. */
const dependsHtml = (flags: Flag[], meta: FeatureMeta): string => {
  if (!meta.depends || meta.depends.length === 0) return ''
  const chips = meta.depends
    .map((dep) => {
      const depMeta = FEATURE_META[dep]
      const label = depMeta ? depMeta.label : humanizeKey(dep)
      const satisfied = isOn(flags, dep)
      return `<span class="dep${satisfied ? ' ok' : ' unmet'}">${satisfied ? '✓' : '○'} needs ${escapeHtml(label)}${satisfied ? '' : ' (off)'}</span>`
    })
    .join('')
  return `<div class="feat-deps">${chips}</div>`
}

/**
 * The Features section body. Renders every flag as a stage-grouped toggle. The whole flag list is
 * embedded as a JSON blob so the browser can PUT the flipped document without re-fetching. Pure.
 */
export const renderFeatures = (data: SetupData): string => {
  const flags = data.flags ?? []
  if (flags.length === 0) {
    return '<div class="card"><div class="note">No feature flags are seeded yet. They appear here once the engine has run once (ensureDefaultFlags).</div></div>'
  }
  const onCount = flags.filter((f) => f.default === true).length
  const byStage = new Map<Stage, { flag: Flag; meta: FeatureMeta }[]>()
  for (const flag of flags) {
    const meta = metaFor(flag)
    const list = byStage.get(meta.stage) ?? []
    list.push({ flag, meta })
    byStage.set(meta.stage, list)
  }
  const stageBlocks = STAGES.filter((s) => byStage.has(s))
    .map((stage) => {
      const rows = (byStage.get(stage) ?? [])
        .map(({ flag, meta }) => {
          const on = flag.default === true
          const tier = flag.minTier ? `<span class="tier-chip">${escapeHtml(flag.minTier)}</span>` : ''
          return (
            `<div class="feat${on ? ' on' : ''}">` +
            `<label class="feat-switch"><input type="checkbox" class="flag-toggle" data-flag-key="${escapeHtml(flag.key)}"${on ? ' checked' : ''} /><span class="track"></span></label>` +
            `<div class="feat-body">` +
            `<div class="feat-head"><span class="feat-label">${escapeHtml(meta.label)}</span>${tier}` +
            `<span class="feat-key">${escapeHtml(flag.key)}</span></div>` +
            `<div class="feat-note">${escapeHtml(meta.note)}</div>` +
            dependsHtml(flags, meta) +
            `</div></div>`
          )
        })
        .join('')
      return (
        `<div class="feat-stage"><div class="feat-stage-head">${escapeHtml(stage)}` +
        `<span class="feat-stage-note">${escapeHtml(STAGE_NOTE[stage])}</span></div>${rows}</div>`
      )
    })
    .join('')
  const tiersUsed = flags.some((f) => f.minTier)
  const tierLegend = tiersUsed
    ? '<div class="sub tier-legend">A feature’s tier chip is the fabric it honestly needs: ' +
      '<span class="tier-chip">T0</span> runs at tier zero (a starter model, no server); ' +
      '<span class="tier-chip">T1</span> BASIC — a served fast tier (~8B-class chat + parakeet-class STT on a ' +
      'residency/concurrency runtime); <span class="tier-chip">T2</span> JUDGE — add a 27B / 35B-A3B-class ' +
      'endpoint to light up the judging layer; <span class="tier-chip">T3</span> beyond. See the model support matrix.</div>'
    : ''
  return (
    '<div class="sub">Compose what openinfo does. Every capability is a document — off by default, flip ' +
    'any combination. Changes take effect without a restart (each flag is read per drain).</div>' +
    tierLegend +
    `<div class="feat-count">${onCount} of ${flags.length} feature${flags.length === 1 ? '' : 's'} on</div>` +
    `<script type="application/json" id="flags-data">${jsonForScript(flags)}</script>` +
    stageBlocks
  )
}

/**
 * Browser wiring for the Features toggles: a change listener over `.flag-toggle` that PUTs the flipped
 * flag document (composing PUT /flags/:key) then reloads so the page reflects real server state.
 * Self-contained IIFE (its own jf/blob helpers) — authored without backticks / ${ / </script so it
 * embeds safely in a template. No new engine capability.
 */
export const FEATURES_SCRIPT = `
(function(){
  function jf(method,path,body){var init={method:method,headers:{}};if(method==='POST'||method==='PUT'||method==='DELETE')init.headers['content-type']='application/json';if(body!==undefined)init.body=JSON.stringify(body);return fetch(path,init).then(function(r){return r.json().catch(function(){return null;}).then(function(j){return {ok:r.ok,status:r.status,json:j};});});}
  function flagsData(){var el=document.getElementById('flags-data'); if(!el)return []; try{return JSON.parse(el.textContent);}catch(e){return [];}}
  document.addEventListener('change',function(e){
    var t=e.target; if(!t||!t.classList||!t.classList.contains('flag-toggle'))return;
    var key=t.dataset.flagKey; var want=!!t.checked;
    var flags=flagsData(); var f=null; for(var i=0;i<flags.length;i++){if(flags[i].key===key){f=flags[i];break;}}
    var body=f?{key:f.key,default:want,scope:f.scope,description:f.description}:{key:key,default:want,scope:'engine',description:key};
    if(f&&f.minTier)body.minTier=f.minTier;
    t.disabled=true;
    jf('PUT','/flags/'+encodeURIComponent(key),body).then(function(r){
      if(!r.ok){alert('Could not update '+key+' ('+r.status+')');t.checked=!want;t.disabled=false;return;}
      location.reload();
    });
  });
})();
`
