/**
 * Pure phonetic + fuzzy string primitives for the entity resolver (#72). Zero runtime deps (repo policy:
 * double-metaphone and Levenshtein are small enough to own in-repo) — every function here is a pure,
 * deterministic function of its inputs, so the resolver stays fixture-testable without sqlite or a model.
 *
 * The pieces:
 *  - `levenshtein` / `editSimilarity` — classic edit distance, normalized to a [0,1] similarity.
 *  - `doubleMetaphone` — a compact Double-Metaphone encoder (primary + secondary codes). It is a faithful
 *    implementation of Lawrence Philips' rule set for the cases ASR corruption actually produces (silent
 *    leading clusters KN/GN/PN/WR/PS, PH/GH→F, soft/hard C and G, TH, vowels-only-at-start, etc.),
 *    validated in phonetic.test.ts against a homophone table rather than a byte-for-byte reference port —
 *    what the resolver needs is that HOMOPHONES COLLAPSE to a shared code, which the tests pin directly.
 *  - `phoneticEqual` — do two tokens share a phonetic code (either primary or secondary)?
 *  - `nameSimilarity` — the per-surface-form blend the resolver's phoneticFuzzy factor maxes over: the
 *    stronger of a whole-string edit similarity and a token-level soft-Jaccard that fuses edit + phonetic
 *    equality. Tuned so an ASR homophone ("pie dev" vs "pi.dev") scores high while two DISTINCT names that
 *    merely share one token ("Sam Lee" vs "Sam Rivera") stay safely below the link floor.
 */

/** Levenshtein edit distance (insert/delete/substitute cost 1). Iterative two-row DP — O(a·b) time, O(b) space. */
export const levenshtein = (a: string, b: string): number => {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]!
}

/** Edit distance as a [0,1] similarity: 1 for identical (incl. two empties), 0 when maximally different. */
export const editSimilarity = (a: string, b: string): number => {
  if (a === b) return 1
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  return 1 - levenshtein(a, b) / max
}

const isVowel = (c: string): boolean => c === 'A' || c === 'E' || c === 'I' || c === 'O' || c === 'U' || c === 'Y'

/**
 * Double Metaphone — returns [primary, secondary]; secondary equals primary unless a rule branches (e.g. a
 * word that could be read two ways). Input is upper-cased and stripped to A–Z before encoding. A non-alpha
 * or empty token encodes to ['', ''].
 */
export const doubleMetaphone = (input: string): [string, string] => {
  const s = input.toUpperCase().replace(/[^A-Z]/g, '')
  if (s.length === 0) return ['', '']
  let primary = ''
  let secondary = ''
  const add = (p: string, sec?: string): void => {
    primary += p
    secondary += sec ?? p
  }
  const at = (i: number): string => (i >= 0 && i < s.length ? s[i]! : '')
  const has = (i: number, ...opts: string[]): boolean => opts.some((o) => s.startsWith(o, i))
  const len = s.length
  const last = len - 1

  // Skip a silent leading cluster: GN, KN, PN, WR, PS → the first letter is silent.
  let i = 0
  if (has(0, 'GN', 'KN', 'PN', 'WR', 'PS')) i = 1
  // Initial X is pronounced Z ("Xavier") → but Double Metaphone codes it 'S'.
  if (at(0) === 'X') {
    add('S')
    i = 1
  }

  while (i < len) {
    const c = at(i)
    switch (c) {
      case 'A':
      case 'E':
      case 'I':
      case 'O':
      case 'U':
      case 'Y':
        if (i === 0) add('A') // vowels encoded only when they lead the word
        i += 1
        break
      case 'B':
        add('P')
        i += at(i + 1) === 'B' ? 2 : 1
        break
      case 'C':
        if (has(i, 'CH')) {
          // CH → usually X (church); some borrowings sound K (character/school) → offer K as secondary.
          if (i === 0 && has(i, 'CHAR', 'CHEM', 'CHOR', 'CHYM', 'CHIA')) add('K')
          else if (has(i, 'CHS') || (i > 0 && has(i - 1, 'SCH'))) add('K')
          else add('X', 'K')
          i += 2
        } else if (has(i, 'CIA')) {
          add('X')
          i += 2
        } else if (has(i, 'CC') && !(i === 1 && at(0) === 'M')) {
          if (has(i + 2, 'I', 'E', 'H') && !has(i + 2, 'HU')) {
            add('KS')
          } else {
            add('K')
          }
          i += 2
        } else if (has(i, 'CK', 'CG', 'CQ')) {
          add('K')
          i += 2
        } else if (has(i, 'CI', 'CE', 'CY')) {
          add('S')
          i += 2
        } else {
          add('K')
          i += 1
        }
        break
      case 'D':
        if (has(i, 'DG')) {
          if (has(i + 2, 'I', 'E', 'Y')) {
            add('J') // DGE/DGI/DGY (edge)
            i += 3
          } else {
            add('TK')
            i += 2
          }
        } else if (has(i, 'DT', 'DD')) {
          add('T')
          i += 2
        } else {
          add('T')
          i += 1
        }
        break
      case 'F':
        add('F')
        i += at(i + 1) === 'F' ? 2 : 1
        break
      case 'G':
        if (has(i, 'GH')) {
          if (i > 0 && !isVowel(at(i - 1))) {
            add('K')
            i += 2
          } else if (i === 0) {
            add(at(i + 2) === 'I' ? 'J' : 'K')
            i += 2
          } else {
            // silent GH (night, though) — usually silent after a vowel
            i += 2
          }
        } else if (has(i, 'GN')) {
          // GN — G silent (sign, gnome)
          if (i === 0 || (i === 1 && !isVowel(at(0)))) {
            add('KN', 'N')
          } else {
            add('KN', 'N')
          }
          i += 2
        } else if (has(i, 'GI', 'GE', 'GY')) {
          add('J', 'K') // soft G, with a hard-G secondary (Germanic names)
          i += 2
        } else if (at(i + 1) === 'G') {
          add('K')
          i += 2
        } else {
          add('K')
          i += 1
        }
        break
      case 'H':
        // keep H only when it lies between two vowels (or leads the word before a vowel); else silent
        if ((i === 0 || isVowel(at(i - 1))) && isVowel(at(i + 1))) add('H')
        i += 1
        break
      case 'J':
        add('J')
        i += at(i + 1) === 'J' ? 2 : 1
        break
      case 'K':
        add('K')
        i += at(i + 1) === 'K' ? 2 : 1
        break
      case 'L':
        add('L')
        i += at(i + 1) === 'L' ? 2 : 1
        break
      case 'M':
        // silent B after M at the end (comb, thumb) is handled by B; just collapse MM
        add('M')
        i += at(i + 1) === 'M' ? 2 : 1
        break
      case 'N':
        add('N')
        i += at(i + 1) === 'N' ? 2 : 1
        break
      case 'P':
        if (at(i + 1) === 'H') {
          add('F') // PH → F (phone)
          i += 2
        } else if (at(i + 1) === 'P' || at(i + 1) === 'B') {
          add('P')
          i += 2
        } else {
          add('P')
          i += 1
        }
        break
      case 'Q':
        add('K')
        i += at(i + 1) === 'Q' ? 2 : 1
        break
      case 'R':
        add('R')
        i += at(i + 1) === 'R' ? 2 : 1
        break
      case 'S':
        if (has(i, 'SH')) {
          add('X')
          i += 2
        } else if (has(i, 'SIO', 'SIA')) {
          add('X', 'S')
          i += 3
        } else if (has(i, 'SC')) {
          // SCH → SK usually (school); SC before I/E/Y → S
          if (at(i + 2) === 'H') {
            add('SK')
          } else if (has(i + 2, 'I', 'E', 'Y')) {
            add('S')
          } else {
            add('SK')
          }
          i += 3
        } else if (has(i, 'SS')) {
          add('S')
          i += 2
        } else {
          add('S')
          i += 1
        }
        break
      case 'T':
        if (has(i, 'TH')) {
          add('0', 'T') // TH → theta '0', with a plain-T secondary (Thomas)
          i += 2
        } else if (has(i, 'TIO', 'TIA')) {
          add('X', 'T')
          i += 3
        } else if (has(i, 'TT', 'TD')) {
          add('T')
          i += 2
        } else {
          add('T')
          i += 1
        }
        break
      case 'V':
        add('F')
        i += at(i + 1) === 'V' ? 2 : 1
        break
      case 'W':
        // W kept only before a vowel (as an implicit 'A' onset merges into vowels-at-start rule); WH → W
        if (has(i, 'WH')) {
          if (isVowel(at(i + 2))) add('A')
          i += 2
        } else {
          if (isVowel(at(i + 1)) && i === 0) add('A')
          i += 1
        }
        break
      case 'X':
        add('KS')
        i += has(i, 'XX', 'XC') ? 2 : 1
        break
      case 'Z':
        add('S')
        i += at(i + 1) === 'Z' ? 2 : 1
        break
      default:
        i += 1
    }
    if (primary.length > 8 && secondary.length > 8) break
    void last
  }
  return [primary, secondary]
}

/** Do two tokens share a phonetic code (primary or secondary of one equals primary or secondary of the other)? */
export const phoneticEqual = (a: string, b: string): boolean => {
  const [ap, as] = doubleMetaphone(a)
  const [bp, bs] = doubleMetaphone(b)
  const codesA = [ap, as].filter((c) => c.length > 0)
  const codesB = [bp, bs].filter((c) => c.length > 0)
  if (codesA.length === 0 || codesB.length === 0) return false
  return codesA.some((x) => codesB.includes(x))
}

/** Normalize a surface form for comparison: lowercase, non-alphanumerics → single spaces, trimmed. */
export const normalizeForm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')

/** Per-token similarity: the stronger of edit similarity and a phonetic-equality signal (homophones). */
const tokenSimilarity = (a: string, b: string): number => {
  if (a === b) return 1
  const ed = editSimilarity(a, b)
  const ph = phoneticEqual(a, b) ? 0.92 : 0
  return Math.max(ed, ph)
}

/**
 * Token-level soft Jaccard: greedily match each token of the shorter list to its best unused partner in the
 * longer list (by tokenSimilarity), sum the matched similarities, and normalize as `matched / (|A|+|B|−matched)`.
 * Unmatched tokens drag the score down — so two names sharing ONE of two tokens cap around 0.4 (below the
 * link floor), while a fully-aligned pair of near-homophones scores high.
 */
const tokenSoftJaccard = (tokensA: string[], tokensB: string[]): number => {
  if (tokensA.length === 0 || tokensB.length === 0) return 0
  const [short, long] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA]
  const used = new Array<boolean>(long.length).fill(false)
  let matched = 0
  for (const t of short) {
    let bestIdx = -1
    let best = 0
    for (let j = 0; j < long.length; j += 1) {
      if (used[j]) continue
      const sim = tokenSimilarity(t, long[j]!)
      if (sim > best) {
        best = sim
        bestIdx = j
      }
    }
    if (bestIdx >= 0) {
      used[bestIdx] = true
      matched += best
    }
  }
  const denom = tokensA.length + tokensB.length - matched
  return denom <= 0 ? 1 : matched / denom
}

/**
 * Similarity between two surface forms in [0,1]. The resolver's phoneticFuzzy factor is the MAX of this
 * over every (heard form) × (record name/alias/heardAs) pair. Identical after normalization ⇒ 1.0 (the
 * exact-match regression path).
 *
 * The token soft-Jaccard is the primary signal — it is order-independent and penalizes unmatched tokens, so
 * two distinct names sharing a first name ("Sam Lee" vs "Sam Rivera") stay safely below the link floor. The
 * whole-string edit similarity (spaces removed) is ONLY consulted when the two forms have a DIFFERENT token
 * count — the split/joined-token case ("git hub" vs "github", "pi dev" vs "pidev") ASR produces — where a
 * spaces-removed comparison is the right lens. When both forms have the SAME token count, whole-string
 * concatenation would over-credit a shared prefix (e.g. "danacruz"/"danapark" share 4 of 8 chars), so it is
 * deliberately NOT used — the per-token blend decides.
 */
export const nameSimilarity = (a: string, b: string): number => {
  const na = normalizeForm(a)
  const nb = normalizeForm(b)
  if (na.length === 0 || nb.length === 0) return 0
  if (na === nb) return 1
  const tokensA = na.split(' ')
  const tokensB = nb.split(' ')
  const tokens = tokenSoftJaccard(tokensA, tokensB)
  const whole = tokensA.length !== tokensB.length ? editSimilarity(na.replace(/ /g, ''), nb.replace(/ /g, '')) : 0
  return Math.max(0, Math.min(1, Math.max(whole, tokens)))
}
