#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { FixtureEnvelopeSchema } from './schema.mjs'
import { canonicalStringify } from './model.mjs'

await writeFile(new URL('./fixture.schema.json', import.meta.url), canonicalStringify(FixtureEnvelopeSchema), 'utf8')
