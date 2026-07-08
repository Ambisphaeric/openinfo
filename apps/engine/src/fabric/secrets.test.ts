import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FileSecretStore } from './secrets.js'

const withFile = async (fn: (file: string) => void): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-secrets-'))
  try {
    fn(join(dir, 'secrets', 'secrets.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('set/resolve/has/listRefs/delete round-trip', async () => {
  await withFile((file) => {
    const store = new FileSecretStore(file)
    assert.deepEqual(store.listRefs(), [])
    assert.equal(store.has('k'), false)
    assert.equal(store.resolve('k'), undefined)

    store.set('remote-llm-key', 'sk-secret-123')
    store.set('remote-stt-key', 'sk-secret-456')
    assert.equal(store.resolve('remote-llm-key'), 'sk-secret-123')
    assert.equal(store.has('remote-llm-key'), true)
    assert.deepEqual(store.listRefs(), ['remote-llm-key', 'remote-stt-key'])

    assert.equal(store.delete('remote-llm-key'), true)
    assert.equal(store.delete('remote-llm-key'), false)
    assert.equal(store.resolve('remote-llm-key'), undefined)
    assert.deepEqual(store.listRefs(), ['remote-stt-key'])
  })
})

test('the file is 0600 and values persist across store instances (reload)', async () => {
  await withFile((file) => {
    new FileSecretStore(file).set('k', 'v')
    const mode = statSync(file).mode & 0o777
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
    // a fresh instance reads the persisted value from disk
    assert.equal(new FileSecretStore(file).resolve('k'), 'v')
  })
})

test('listRefs and the on-disk shape are the guarantee — refs are keys, values are the only place a secret lives', async () => {
  await withFile((file) => {
    const store = new FileSecretStore(file)
    store.set('my-ref', 'the-secret')
    // listRefs never surfaces a value
    assert.equal(JSON.stringify(store.listRefs()).includes('the-secret'), false)
    // the value IS on disk (that is the point) but only in the 0600 file, never elsewhere
    assert.equal(readFileSync(file, 'utf8').includes('the-secret'), true)
  })
})

test('a fresh install writes nothing until the first set', async () => {
  await withFile((file) => {
    const store = new FileSecretStore(file)
    assert.equal(store.listRefs().length, 0)
    assert.throws(() => statSync(file)) // no file created just by constructing/reading
  })
})
