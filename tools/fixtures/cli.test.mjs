import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(dirname(here))
const cli = join(here, 'cli.mjs')
const sample = join(here, 'fixtures', 'synthetic-converged.v1.json')
const events = join(here, 'examples', 'synthetic-converged.jsonl')

test('validate and replay CLI emit payload-free summaries', async () => {
  for (const mode of ['validate', 'replay']) {
    const { stdout, stderr } = await exec(process.execPath, [cli, mode, '--input', sample], { cwd: root })
    assert.equal(stderr, '')
    const summary = JSON.parse(stdout)
    assert.equal(summary.ok, true)
    assert.equal(summary.mode, mode)
    assert.equal(summary.entries, 8)
    assert.equal(stdout.includes('Pull request 150'), false, 'CLI summary leaked fixture payload text')
    assert.equal(stdout.includes('U1lOVEhF'), false, 'CLI summary leaked base64 media')
  }
})

test('record CLI is no-overwrite by default and force replacement pins owner-only permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-fixture-cli-'))
  const output = join(dir, 'synthetic.json')
  try {
    const args = [cli, 'record', '--input', events, '--output', output, '--privacy', 'synthetic', '--allow-raw-media', '--replay-at', '2026-07-12T13:00:03.000Z']
    await exec(process.execPath, args, { cwd: root })
    await assert.rejects(() => exec(process.execPath, args, { cwd: root }), /exists \(pass --force to replace\)/)
    await chmod(output, 0o644)
    await exec(process.execPath, [...args, '--force'], { cwd: root })
    // POSIX-only: Windows has no 0o600 equivalent (stat reports 0o666). The owner-only write is a real
    // guarantee off-Windows; on Windows the file is NOT mode-restricted (a documented platform gap).
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600)
    assert.equal((await readFile(output, 'utf8')).endsWith('\n'), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sensitive fixtures are refused outside the ignored fixture root and accepted inside private/', async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), 'openinfo-fixture-sensitive-'))
  const outside = join(outsideDir, 'sensitive.local.json')
  const privateRoot = join(here, 'private')
  await mkdir(privateRoot, { recursive: true, mode: 0o700 })
  const privateDir = await mkdtemp(join(privateRoot, 'cli-'))
  const inside = join(privateDir, 'sensitive.json')
  const base = [cli, 'record', '--input', events, '--privacy', 'sensitive', '--allow-raw-media', '--replay-at', '2026-07-12T13:00:03.000Z']
  try {
    await assert.rejects(
      () => exec(process.execPath, [...base, '--output', outside], { cwd: root }),
      /refusing committable output/,
    )
    await exec(process.execPath, [...base, '--output', inside], { cwd: root })
    if (process.platform !== 'win32') assert.equal((await stat(inside)).mode & 0o777, 0o600)
  } finally {
    await rm(outsideDir, { recursive: true, force: true })
    await rm(privateDir, { recursive: true, force: true })
  }
})

test('invalid fixture exits nonzero before writing a summary file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openinfo-fixture-invalid-'))
  const broken = join(dir, 'broken.json')
  const summary = join(dir, 'summary.json')
  try {
    await writeFile(broken, '{', 'utf8')
    await assert.rejects(() => exec(process.execPath, [cli, 'replay', '--input', broken, '--output', summary], { cwd: root }), /invalid JSON/)
    await assert.rejects(() => stat(summary))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
