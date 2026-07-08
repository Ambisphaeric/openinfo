import type { SetupData } from '../../setup/view.js'

/**
 * The Benchmarks section — a reserved home (present-but-future, honest) for the founder's coming
 * capability-benchmarking system. That system will measure each endpoint's real throughput on THIS
 * hardware (RAM / VRAM constraints → measured tok/s per slot) and map those numbers to queue policies
 * that decide what runs where (audio / OCR / LLM / VLM work). It is a later slice with its own design
 * note; this section reserves the DIAGNOSTICS slot and states plainly what will live here — no faked
 * numbers, no dead controls beyond the honest disabled affordance in the endpoint editor.
 *
 * Pure, node-tested — like every section, one render function behind the registry.
 */
export const renderBenchmarks = (_data: SetupData): string =>
  '<div class="sub">Measure what your hardware can actually do, then let openinfo schedule work to fit it.</div>' +
  '<div class="future">' +
  '<span class="future-badge">Coming soon</span>' +
  '<h3>Capability benchmarking</h3>' +
  '<p>openinfo will measure each configured endpoint’s real throughput on <b>this</b> machine — not a spec ' +
  'sheet — and turn those numbers into scheduling policy. Today the endpoint editor can <span class="mono">Test</span> ' +
  'reachability; benchmarking extends that same set → connect → test → <b>benchmark</b> progression with measured ' +
  'tok/s.</p>' +
  '<p>What will live here:</p>' +
  '<ul>' +
  '<li>Hardware envelope you declare or we detect — e.g. <span class="mono">16 GB RAM</span>, <span class="mono">12 GB VRAM</span>.</li>' +
  '<li>Measured tok/s per endpoint and per slot (llm / stt / vlm / ocr), run on demand.</li>' +
  '<li>Queue policies mapped from those measurements — which work (audio, OCR, LLM, VLM) runs where, and how much can run at once without starving the pipeline.</li>' +
  '</ul>' +
  '<p>Until then, per-endpoint <span class="mono">Benchmark</span> buttons in the editor are shown but disabled, ' +
  'with an honest note — real numbers need a hardware run.</p>' +
  '</div>'
