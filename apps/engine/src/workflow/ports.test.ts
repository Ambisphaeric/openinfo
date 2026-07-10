import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AllSchemas } from '@openinfo/contracts'
import { loadDefaultWorkflow } from './defaults.js'
import { STEP_PORTS } from './ports.js'

/** The step-kind literals, read from the CONTRACT (the WorkflowStepKind union in AllSchemas) — not from
 * the table under test — so the totality check keeps meaning something when a kind is appended. */
const contractKinds = (): string[] => {
  const schema = AllSchemas['WorkflowStepKind'] as { anyOf?: { const?: unknown }[] } | undefined
  assert.ok(schema?.anyOf, 'WorkflowStepKind schema with anyOf literals must exist in AllSchemas')
  const kinds = schema.anyOf.map((v) => v.const).filter((k): k is string => typeof k === 'string')
  assert.ok(kinds.length > 0)
  return kinds
}

test('#121 totality: every WorkflowStepKind in the CONTRACT has a ports entry, and no extras', () => {
  const kinds = contractKinds().sort()
  assert.deepEqual(Object.keys(STEP_PORTS).sort(), kinds)
})

test('#121 validity: every named port is a real contract $id in AllSchemas', () => {
  for (const [kind, ports] of Object.entries(STEP_PORTS)) {
    for (const id of [...ports.inputs, ...ports.outputs, ...(ports.emits ?? [])]) {
      assert.ok(id in AllSchemas, `${kind}: '${id}' is not a contract in AllSchemas`)
    }
  }
})

test('#121 shape: every kind names at least one input and one output, and a non-empty description', () => {
  for (const [kind, ports] of Object.entries(STEP_PORTS)) {
    assert.ok(ports.inputs.length > 0, `${kind}: no inputs`)
    assert.ok(ports.outputs.length > 0, `${kind}: no outputs`)
    assert.ok(ports.description.trim().length > 0, `${kind}: empty description`)
    if (ports.emits) {
      // emits is only for payloads that are NOT already outputs (the ephemeral fast-path feeds).
      for (const id of ports.emits) assert.ok(!ports.outputs.includes(id), `${kind}: '${id}' is both an output and an emit`)
    }
  }
})

test('#121 document check: every step in the seeded workflow-default has a ports entry', () => {
  const doc = loadDefaultWorkflow()
  for (const step of doc.steps) {
    assert.ok(step.kind in STEP_PORTS, `default workflow step '${step.id}' (${step.kind}) has no ports entry`)
  }
})

test('#121 pipeline coherence: in the seeded default, each drain step downstream of another can consume an upstream output', () => {
  // The seeded default mirrors the hardcoded pipeline, so its drain steps must CHAIN: for every drain
  // step after the first, SOME earlier drain step's output (or the drain batch itself, CaptureChunk)
  // satisfies one of its inputs. This is the exact check a graph editor performs on a connection —
  // asserted here against the shipped document so the table and the document cannot drift apart.
  const doc = loadDefaultWorkflow()
  const drainSteps = doc.steps.filter((s) => (s.trigger ?? 'drain') === 'drain')
  const available = new Set<string>(['CaptureChunk']) // the drain batch every drain step can read
  for (const step of drainSteps) {
    const ports = STEP_PORTS[step.kind as keyof typeof STEP_PORTS]
    assert.ok(ports, `default workflow step '${step.id}' (${step.kind}) has no ports entry`)
    assert.ok(
      ports.inputs.some((id) => available.has(id)),
      `default workflow step '${step.id}' (${step.kind}) has no satisfiable input among [${[...available].join(', ')}]`,
    )
    for (const out of ports.outputs) available.add(out)
  }
})
