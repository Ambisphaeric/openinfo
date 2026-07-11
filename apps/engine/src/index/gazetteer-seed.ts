/**
 * The seeded PUBLIC-NAME GAZETTEER document (#143) — a compact, static v0 list of well-known
 * OSS/product names and their common aliases. It is the RIVAL SOURCE the clarify gate lacked: without a
 * concept of a plausible OUTSIDE name, a corporate repo that happens to sound like a famous open-source
 * project (a "Kubeflow-like internal repo" vs the public Kubeflow) can never trip the ≟ affordance — the
 * resolver would silently link to the corpus entity, blind to the collision. This document supplies the
 * outside rival so the resolver's existing ambiguity logic can name it.
 *
 * It is a STORE DOCUMENT like every other config doc (fabric profiles, prompt templates, modes): seeded
 * seed-if-absent into `_meta.db` (see `WorkspaceRegistry.gazetteer`), user-editable, and NEVER clobbered
 * once present — a user who prunes or extends it owns it thereafter. Static in v0: no network fetch, no
 * auto-population (repo minimal-dep policy + a deterministic, inspectable rival source). The matcher
 * (`gazetteer.ts`) reads whatever the store returns; growing the list is a pure data edit.
 *
 * Curation rule for the seed: names must be BROADLY known public software so a same-sounding internal
 * artifact is genuinely a collision worth a one-tap disambiguation — not obscure names that would only
 * add ≟ noise. Aliases capture the spoken/abbreviated forms ASR actually produces ("k8s", "postgres",
 * "tf"). This is a naming-collision source, NOT an entity corpus: a gazetteer hit is only ever a rival,
 * never a record the resolver links to or creates (see `gazetteer.ts`).
 */

/** The store kind + key the gazetteer document is versioned under in `_meta.db` (LayoutStore). */
export const GAZETTEER_KIND = 'gazetteer'
export const GAZETTEER_KEY = 'gazetteer-default'

/** One well-known public name. `aliases` are the spoken/abbreviated forms; `category` is descriptive only. */
export interface GazetteerEntry {
  name: string
  aliases?: readonly string[]
  category?: string
}

/** The gazetteer document body — a flat, user-editable list of public names. */
export interface GazetteerDocument {
  entries: readonly GazetteerEntry[]
}

/**
 * The shipped v0 gazetteer: ~30 broadly-known infrastructure / data / ML OSS projects and platforms —
 * exactly the space where an internal repo tends to reuse a famous name. Deliberately compact and static;
 * a user extends it by editing the document. `aliases` carry the abbreviations ASR commonly emits.
 */
export const DEFAULT_GAZETTEER: GazetteerDocument = {
  entries: [
    { name: 'Kubernetes', aliases: ['k8s', 'kube'], category: 'infra' },
    { name: 'Kubeflow', category: 'ml' },
    { name: 'Docker', category: 'infra' },
    { name: 'Terraform', aliases: ['tf'], category: 'infra' },
    { name: 'Ansible', category: 'infra' },
    { name: 'Jenkins', category: 'infra' },
    { name: 'Prometheus', category: 'infra' },
    { name: 'Grafana', category: 'infra' },
    { name: 'Helm', category: 'infra' },
    { name: 'Istio', category: 'infra' },
    { name: 'Consul', category: 'infra' },
    { name: 'Vault', category: 'infra' },
    { name: 'Nginx', category: 'infra' },
    { name: 'Kafka', aliases: ['apache kafka'], category: 'data' },
    { name: 'Redis', category: 'data' },
    { name: 'PostgreSQL', aliases: ['postgres', 'psql'], category: 'data' },
    { name: 'MongoDB', aliases: ['mongo'], category: 'data' },
    { name: 'Elasticsearch', aliases: ['elastic'], category: 'data' },
    { name: 'Cassandra', category: 'data' },
    { name: 'Spark', aliases: ['apache spark'], category: 'data' },
    { name: 'Hadoop', category: 'data' },
    { name: 'Airflow', aliases: ['apache airflow'], category: 'data' },
    { name: 'Snowflake', category: 'data' },
    { name: 'TensorFlow', aliases: ['tf'], category: 'ml' },
    { name: 'PyTorch', category: 'ml' },
    { name: 'Jupyter', category: 'ml' },
    { name: 'GraphQL', category: 'web' },
    { name: 'Kibana', category: 'data' },
    { name: 'RabbitMQ', category: 'infra' },
    { name: 'Envoy', category: 'infra' },
  ],
}
