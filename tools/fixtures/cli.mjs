#!/usr/bin/env node
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FixtureError,
  canonicalStringify,
  createFixtureReplay,
  fixtureSummary,
  parseFixture,
  recordFixture,
} from './model.mjs'

const HELP = `openinfo fixture record/replay

Usage:
  node tools/fixtures/cli.mjs record --input <events.jsonl|json> --output <fixture.json>
    --privacy <synthetic|sanitized|sensitive> [--contains-personal-data]
    [--allow-raw-media] [--recorded-at <ISO>] [--replay-at <ISO>] [--force]
  node tools/fixtures/cli.mjs validate --input <fixture.json> [--output <summary.json>]
  node tools/fixtures/cli.mjs replay --input <fixture.json> [--output <summary.json>]

Record is fail-closed: inline audio/image bytes require --allow-raw-media. media:"raw",
sensitive, or personal-data fixtures may only be written under tools/fixtures/private/ or
to a *.local.json path. Replay validates the entire fixture and its digest before touching
any entry; its output is a payload-free machine-readable summary and performs no model/network calls.
`

const args = process.argv.slice(2)
const command = args[0]
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = args[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}
const has = (name) => args.includes(`--${name}`)
const requireString = (name) => {
  const value = flag(name)
  if (typeof value !== 'string') throw new FixtureError(`--${name} is required`)
  return value
}

const readEntries = async (path) => {
  const text = await readFile(path, 'utf8')
  if (path.endsWith('.jsonl')) {
    const entries = []
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (line.trim() === '') continue
      try {
        entries.push(JSON.parse(line))
      } catch (error) {
        throw new FixtureError(`${path}:${index + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return entries
  }
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new FixtureError(`${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(value)) throw new FixtureError(`${path}: record input JSON must be an array (or use JSONL)`)
  return value
}

const privateOutput = (path) => {
  const absolute = resolve(path)
  const fixturesRoot = dirname(fileURLToPath(import.meta.url))
  const within = relative(fixturesRoot, absolute)
  if (within === '' || within.startsWith(`..${sep}`) || within === '..' || isAbsolute(within)) return false
  return within.startsWith(`private${sep}`) || within.endsWith('.local.json')
}

const assertSafeOutput = (path, fixture) => {
  const privateData = fixture.privacy.classification === 'sensitive' || fixture.privacy.containsPersonalData === true ||
    fixture.entries.some((entry) => entry.kind === 'capture' && entry.media === 'raw')
  if (privateData && !privateOutput(path)) {
    throw new FixtureError(`refusing committable output for sensitive/personal fixture: use tools/fixtures/private/ or *.local.json`)
  }
}

const writeOwnerOnly = async (path, value, { force = false } = {}) => {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 })
  if (!force) {
    try {
      await access(path, constants.F_OK)
      throw new FixtureError(`${path}: exists (pass --force to replace)`)
    } catch (error) {
      if (error instanceof FixtureError) throw error
    }
  }
  const handle = await open(path, force ? 'w' : 'wx', 0o600)
  try {
    await handle.chmod(0o600)
    await handle.writeFile(value, 'utf8')
  } finally {
    await handle.close()
  }
}

const writeSummary = async (summary) => {
  const output = flag('output')
  const body = canonicalStringify(summary)
  if (typeof output === 'string') await writeFile(output, body, { encoding: 'utf8', mode: 0o600 })
  else process.stdout.write(body)
}

const main = async () => {
  if (command === undefined || command === 'help' || has('help')) {
    process.stdout.write(HELP)
    return
  }
  if (command === 'record') {
    const input = requireString('input')
    const output = requireString('output')
    const privacy = requireString('privacy')
    const fixture = recordFixture(await readEntries(input), {
      classification: privacy,
      allowRawMedia: has('allow-raw-media'),
      containsPersonalData: has('contains-personal-data'),
      ...(typeof flag('recorded-at') === 'string' ? { recordedAt: flag('recorded-at') } : {}),
      ...(typeof flag('replay-at') === 'string' ? { replayAt: flag('replay-at') } : {}),
    })
    assertSafeOutput(output, fixture)
    await writeOwnerOnly(output, canonicalStringify(fixture), { force: has('force') })
    process.stdout.write(canonicalStringify(fixtureSummary(fixture)))
    return
  }
  if (command !== 'validate' && command !== 'replay') throw new FixtureError(`unknown command ${JSON.stringify(command)}\n\n${HELP}`)
  const input = requireString('input')
  const fixture = parseFixture(await readFile(input, 'utf8'), input)
  if (command === 'replay') {
    // Constructing the pure boundary indexes every recorded result after full prevalidation. Walking the
    // entries proves the replay can be consumed; no payload is emitted and no fetch/model API exists here.
    const replay = createFixtureReplay(fixture)
    replay.entries()
  }
  await writeSummary({ mode: command, ...fixtureSummary(fixture) })
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`fixture ${command ?? 'command'} failed: ${message}\n`)
  process.exitCode = 1
})
