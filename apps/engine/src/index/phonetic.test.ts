import { test } from 'node:test'
import assert from 'node:assert/strict'
import { doubleMetaphone, editSimilarity, levenshtein, nameSimilarity, phoneticEqual } from './phonetic.js'

test('levenshtein + editSimilarity: identical, empty, and known distances', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3)
  assert.equal(levenshtein('same', 'same'), 0)
  assert.equal(levenshtein('', 'abc'), 3)
  assert.equal(editSimilarity('abc', 'abc'), 1)
  assert.equal(editSimilarity('', ''), 1)
  assert.equal(editSimilarity('abc', 'abd'), 1 - 1 / 3)
})

test('doubleMetaphone: non-alpha / empty encode to empty codes', () => {
  assert.deepEqual(doubleMetaphone(''), ['', ''])
  assert.deepEqual(doubleMetaphone('123'), ['', ''])
})

test('doubleMetaphone: ASR homophones collapse to a shared phonetic code', () => {
  // Each pair is a homophone / near-homophone ASR routinely confuses — they MUST share a code.
  const homophones: [string, string][] = [
    ['pie', 'pi'],
    ['jon', 'john'],
    ['smith', 'smyth'],
    ['catherine', 'katherine'],
    ['phone', 'fone'],
    ['knight', 'night'],
    ['wright', 'right'],
    ['gnome', 'nome'],
    ['sea', 'see'],
    ['byte', 'bite'],
  ]
  for (const [a, b] of homophones) {
    assert.ok(phoneticEqual(a, b), `expected "${a}" and "${b}" to be phonetically equal (codes ${JSON.stringify(doubleMetaphone(a))} vs ${JSON.stringify(doubleMetaphone(b))})`)
  }
})

test('doubleMetaphone: genuinely different words do NOT collapse', () => {
  const distinct: [string, string][] = [
    ['rivera', 'lee'],
    ['dana', 'marcus'],
    ['widgets', 'renewal'],
    ['thursday', 'monday'],
  ]
  for (const [a, b] of distinct) {
    assert.ok(!phoneticEqual(a, b), `expected "${a}" and "${b}" to be phonetically distinct`)
  }
})

test('nameSimilarity: exact (post-normalization) is 1.0 — the exact-match regression path', () => {
  assert.equal(nameSimilarity('Sam Rivera', 'sam  rivera'), 1)
  assert.equal(nameSimilarity('pi.dev', 'PI DEV'), 1) // punctuation normalizes away
})

test('nameSimilarity: ASR corruptions of one name score high (link band)', () => {
  // homophone + dropped punctuation
  assert.ok(nameSimilarity('pie dev', 'pi.dev') >= 0.7, `pie dev/pi.dev = ${nameSimilarity('pie dev', 'pi.dev')}`)
  // split tokens
  assert.ok(nameSimilarity('git hub', 'github') >= 0.85, `git hub/github = ${nameSimilarity('git hub', 'github')}`)
  // near-miss consonant
  assert.ok(nameSimilarity('Katherine', 'Catherine') >= 0.85, `Katherine/Catherine = ${nameSimilarity('Katherine', 'Catherine')}`)
})

test('nameSimilarity: two DISTINCT names sharing one token stay below the link floor (0.5)', () => {
  assert.ok(nameSimilarity('Sam Lee', 'Sam Rivera') < 0.5, `Sam Lee/Sam Rivera = ${nameSimilarity('Sam Lee', 'Sam Rivera')}`)
  assert.ok(nameSimilarity('Dana Cruz', 'Dana Park') < 0.5, `Dana Cruz/Dana Park = ${nameSimilarity('Dana Cruz', 'Dana Park')}`)
})

test('nameSimilarity: empty / whitespace-only forms score 0 (no false match)', () => {
  assert.equal(nameSimilarity('', 'anything'), 0)
  assert.equal(nameSimilarity('   ', 'anything'), 0)
})
