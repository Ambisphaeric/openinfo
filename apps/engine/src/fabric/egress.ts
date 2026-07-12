import type { ContentClass, EgressDecision, EgressLayer, EgressReach, Endpoint } from '@openinfo/contracts'

/**
 * Layered egress-consent policy (#64) — the pure, testable core. "Egress" is one question: may this
 * content leave the machine? It is resolved across FOUR layers, ANY of which can deny; the MOST-SPECIFIC
 * denial wins and the decision records WHICH layer decided (the voice-binding `scope` precedent). Nothing
 * here does I/O or picks endpoints — enforcement (invoke.ts) classifies each candidate endpoint with
 * `classifyEndpoint` (layer 1) and checks it against the content-side consent `resolveEgress` returns.
 */

/**
 * Layer 1 — classify an endpoint's REACH purely from what the endpoint document says. A `local` endpoint
 * is served by an engine-spawned runtime (tier zero, always local); a `cloud` endpoint is egress by its
 * nature; an `http` endpoint is classified from its URL host (loopback/LAN → local, otherwise → egress).
 * Pure and total: an unparseable/odd http url is treated as `egress` (fail CLOSED — never assume a host
 * we cannot read is local).
 */
export const classifyEndpoint = (endpoint: Endpoint): EgressReach => {
  if (endpoint.kind === 'local') return 'local'
  if (endpoint.kind === 'cloud') return 'egress'
  return classifyHost(endpoint.url)
}

/** Extract the lowercased hostname from an http(s) URL, or undefined when it cannot be parsed. An IPv6
 * host arrives bracketed from `URL.hostname` (e.g. `[::1]`) — the brackets are stripped so range checks
 * see the bare address. */
const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return undefined
  }
}

/**
 * Is an endpoint confined to this machine, rather than merely reachable on the private LAN? This is
 * deliberately narrower than `classifyEndpoint`: managed `local` runtimes are engine-spawned on
 * loopback, while an http endpoint must name localhost, 127.0.0.0/8, or ::1. Wildcard bind addresses
 * (0.0.0.0 / ::), private IPs, link-local IPs, and mDNS names are NOT loopback destinations.
 *
 * Raw screen frames use this predicate before OCR/VLM invocation. Other content retains the broader
 * local-vs-egress classification, so this does not change existing private-LAN model support generally.
 */
export const isLoopbackEndpoint = (endpoint: Endpoint): boolean => {
  if (endpoint.kind === 'local') return true
  if (endpoint.kind === 'cloud') return false
  const host = hostOf(endpoint.url)
  if (host === undefined) return false
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  return v4 !== null && Number(v4[1]) === 127
}

/**
 * Is a hostname loopback or a private/link-local LAN address (or an mDNS `.local` name)? Such a host never
 * leaves the machine's own network, so it is `local`; everything else (a public hostname or routable IP)
 * is `egress`. Covers IPv4 loopback/private/link-local ranges, IPv6 loopback/ULA/link-local, `0.0.0.0`,
 * and `*.local`. Bracketed IPv6 hosts arrive from `URL.hostname` already unbracketed.
 */
export const classifyHost = (url: string): EgressReach => {
  const host = hostOf(url)
  if (host === undefined) return 'egress' // fail closed — an unreadable host is never assumed local
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.localhost')) return 'local'
  if (host === '::1' || host === '::' ) return 'local'
  if (host.endsWith('.local')) return 'local' // mDNS / Bonjour name — same-LAN by definition
  // IPv6 unique-local (fc00::/7 ⇒ fc.. / fd..) and link-local (fe80::/10) — same-machine/same-LAN.
  if (/^f[cd][0-9a-f]*:/.test(host) || /^fe[89ab][0-9a-f]*:/.test(host)) return 'local'
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127) return 'local' // 127.0.0.0/8 loopback
    if (a === 10) return 'local' // 10.0.0.0/8 private
    if (a === 192 && b === 168) return 'local' // 192.168.0.0/16 private
    if (a === 172 && b >= 16 && b <= 31) return 'local' // 172.16.0.0/12 private
    if (a === 169 && b === 254) return 'local' // 169.254.0.0/16 link-local
    return 'egress'
  }
  return 'egress'
}

/**
 * The content-side consent verdict `resolveEgress` returns — the which-layer-won provenance, BEFORE it is
 * fused with the reach of whichever endpoint actually answered. `allowed:false` ⇒ egress-capable endpoints
 * must be filtered out for this content; `decidedBy` names the layer that decided (the most-specific
 * denier, or `default` when nothing denied).
 */
export interface EgressConsent {
  allowed: boolean
  decidedBy: EgressLayer
  reason: string
}

/**
 * The four content-side signals resolution reads (layer 1, the endpoint, is enforced separately). Every
 * field is optional and derived from what the pipeline already knows — no new upstream tagging:
 *  - `contentClass` (layer 4): the datum's origin; `screen` denies, others do not.
 *  - `promptNeverEgress` (layer 2): the prompt document's `neverEgress` flag.
 *  - `modeDenies` (layer 3): the active mode's `egress.deny`.
 *  - `workspaceDenies` (layer 3): the workspace's `egress.deny`.
 */
export interface EgressContext {
  contentClass?: ContentClass | undefined
  promptNeverEgress?: boolean | undefined
  modeDenies?: boolean | undefined
  workspaceDenies?: boolean | undefined
}

/**
 * Resolve the layered content-side egress consent. Walks the specificity precedence MOST-SPECIFIC → LEAST
 * and returns the FIRST layer that denies (most-specific denial wins), recording which layer decided:
 *   content-class (this datum) → prompt (this template) → mode → workspace (the broadest container).
 * When no layer denies, egress is ALLOWED with `decidedBy:'default'` — but note that "allowed" only means
 * the CONTENT may leave; whether a path out actually EXISTS is the endpoint layer, enforced downstream (a
 * fresh install has no egress endpoint, so allowed content still never leaves). Pure.
 */
export const resolveEgress = (ctx: EgressContext): EgressConsent => {
  if (ctx.contentClass === 'screen') {
    return { allowed: false, decidedBy: 'content-class', reason: 'raw screen content is restricted to this machine' }
  }
  if (ctx.promptNeverEgress === true) {
    return { allowed: false, decidedBy: 'prompt', reason: 'this prompt is declared never-egress' }
  }
  if (ctx.modeDenies === true) {
    return { allowed: false, decidedBy: 'mode', reason: 'the active mode denies egress' }
  }
  if (ctx.workspaceDenies === true) {
    return { allowed: false, decidedBy: 'workspace', reason: 'this workspace denies egress' }
  }
  return { allowed: true, decidedBy: 'default', reason: 'no layer denied egress' }
}

/**
 * Fuse a consent verdict with the reach of the endpoint that ANSWERED into the record-stamped decision.
 * A record with `reach:'egress'` can only exist when consent allowed it (a denied-egress endpoint is
 * filtered before it runs), so this preserves the honest invariant. When the content STAYED local because
 * egress was denied, the local reach is paired with the denying layer so the ledger can say exactly why.
 */
export const egressDecision = (reach: EgressReach, consent: EgressConsent): EgressDecision => ({
  reach,
  allowed: consent.allowed,
  decidedBy: consent.decidedBy,
  reason:
    reach === 'egress'
      ? `content left the machine (${consent.reason})`
      : consent.allowed
        ? consent.reason
        : `stayed local: ${consent.reason}`,
})
