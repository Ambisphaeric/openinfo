import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Flag, ScreenStatus, WorkflowSpec } from '@openinfo/contracts'
import { createSecureTestEngineApp, secureTestFetch } from '../api/test-control-plane.js'

const putFlag = async (base: string, key: string, enabled: boolean): Promise<void> => {
  const flag: Flag = { key, default: enabled, scope: 'engine', description: `screen status test: ${key}` }
  const response = await secureTestFetch(`${base}/flags/${key}`, {
    method: 'PUT',
    body: JSON.stringify(flag),
  })
  assert.equal(response.status, 200)
}

const readStatus = async (base: string): Promise<ScreenStatus> =>
  (await (await secureTestFetch(`${base}/screen/status`)).json()) as ScreenStatus

test('/screen/status fallback reports the active legacy/workflow owner, including alternate and ungated step flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-screen-status-owner-'))
  const app = createSecureTestEngineApp({ dataRoot: dir, log: () => undefined })
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`

  try {
    // No wireScreenOcr call: this exercises router.ts's honest zero-counter fallback.
    assert.equal((await readStatus(base)).enabled, false)
    await putFlag(base, 'screen.ocr', true)
    assert.equal((await readStatus(base)).enabled, true, 'legacy ownership follows screen.ocr')

    const current = (await (await secureTestFetch(`${base}/workflows/workflow-default`)).json()) as WorkflowSpec
    const alternateFlag: WorkflowSpec = {
      ...current,
      steps: [{
        id: 'screen-vlm-status',
        kind: 'vlm',
        slot: 'vlm',
        trigger: 'drain',
        when: { flag: 'screen.vlm' },
        params: {},
      }],
    }
    assert.equal((await secureTestFetch(`${base}/workflows/workflow-default`, {
      method: 'PUT',
      body: JSON.stringify(alternateFlag),
    })).status, 200)
    await putFlag(base, 'screen.ocr', false)
    await putFlag(base, 'screen.vlm', true)
    await putFlag(base, 'workflow.enabled', true)
    const flags = (await (await secureTestFetch(`${base}/flags`)).json()) as Flag[]
    assert.equal(flags.find((flag) => flag.key === 'screen.vlm')?.default, true, 'custom workflow flags are observable')
    assert.equal(
      (await readStatus(base)).enabled,
      true,
      'workflow ownership reads the step\'s custom flag rather than the legacy screen.ocr flag',
    )

    await putFlag(base, 'screen.vlm', false)
    assert.equal((await readStatus(base)).enabled, false, 'a workflow with no enabled screen step is disabled')

    const saved = (await (await secureTestFetch(`${base}/workflows/workflow-default`)).json()) as WorkflowSpec
    const ungated: WorkflowSpec = {
      ...saved,
      steps: saved.steps.map(({ when: _when, ...step }) => step),
    }
    assert.equal((await secureTestFetch(`${base}/workflows/workflow-default`, {
      method: 'PUT',
      body: JSON.stringify(ungated),
    })).status, 200)
    assert.equal((await readStatus(base)).enabled, true, 'an ungated workflow screen step is enabled')
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
