import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClientLog } from './client-log.js'

const tmp = () => mkdtemp(join(tmpdir(), 'client-log-'))

test('appends one timestamped line per call and creates the parent dir', async () => {
  const dir = await tmp()
  const file = join(dir, 'logs', 'client.log') // nested dir must be created
  const log = createClientLog({ file, mirror: () => {}, now: () => new Date('2026-07-09T12:00:00.000Z') })
  log('first')
  log('second')
  const body = await readFile(file, 'utf8')
  assert.equal(body, '2026-07-09T12:00:00.000Z first\n2026-07-09T12:00:00.000Z second\n')
})

test('mirrors every line to the provided sink (so a dev run still sees stdout)', async () => {
  const dir = await tmp()
  const seen: string[] = []
  const log = createClientLog({ file: join(dir, 'client.log'), mirror: (l) => seen.push(l), now: () => new Date('2026-07-09T00:00:00.000Z') })
  log('hello')
  assert.deepEqual(seen, ['2026-07-09T00:00:00.000Z hello'])
})

test('rotates to <file>.1 once the cap is crossed, bounding on-disk size', async () => {
  const dir = await tmp()
  const file = join(dir, 'client.log')
  // A tiny cap so a couple of lines force a rollover.
  const log = createClientLog({ file, maxBytes: 80, mirror: () => {}, now: () => new Date('2026-07-09T00:00:00.000Z') })
  // Each line is ~46 bytes (24-char ISO + space + 20 + newline), so every write past the first crosses
  // the 80-byte cap and rolls the previous active file into the SINGLE backup (replacing the older one).
  log('aaaaaaaaaaaaaaaaaaaa')
  log('bbbbbbbbbbbbbbbbbbbb') // rolls the 'aaaa' file into .1, writes 'bbbb' fresh
  log('cccccccccccccccccccc') // rolls the 'bbbb' file into .1 (replacing 'aaaa'), writes 'cccc' fresh

  assert.ok(existsSync(`${file}.1`), 'a backup file was created on rollover')
  const active = await readFile(file, 'utf8')
  const rolled = await readFile(`${file}.1`, 'utf8')
  assert.ok(active.includes('cccc'), 'the newest line is in the active file')
  assert.ok(rolled.includes('bbbb'), 'the previous line is in the single backup')
  assert.ok(!rolled.includes('aaaa') && !active.includes('aaaa'), 'the oldest line aged out — on-disk usage is bounded')
  // Only the two files exist — a single backup, never an unbounded pile.
  const files = (await readdir(dir)).sort()
  assert.deepEqual(files, ['client.log', 'client.log.1'])
  const activeSize = (await stat(file)).size
  assert.ok(activeSize <= 80 * 2, 'the active file stays bounded around the cap')
})

test('never throws when the target path is unwritable (logging must not crash capture)', () => {
  // Point at a path whose parent cannot be created (a file used as a directory component).
  const log = createClientLog({ file: '/dev/null/nope/client.log', mirror: () => {} })
  assert.doesNotThrow(() => log('this must be swallowed'))
})
