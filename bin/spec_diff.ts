/**
 * Re-downloads the Chariow OpenAPI spec and reports what changed against the
 * vendored copy, so hand-written types cannot go stale silently.
 *
 *   node --import=@poppinss/ts-exec bin/spec_diff.ts
 */
import { readFile, writeFile } from 'node:fs/promises'

const SPEC_URL = 'https://chariow.dev/api-reference/openapi.json'
const LOCAL = new URL('../resources/openapi.json', import.meta.url)

type Spec = {
  info?: { version?: string }
  paths: Record<string, Record<string, unknown>>
  components?: { schemas?: Record<string, unknown> }
}

function operations(spec: Spec): Set<string> {
  const found = new Set<string>()

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      found.add(`${method.toUpperCase()} ${path}`)
    }
  }

  return found
}

function report(label: string, before: Set<string>, after: Set<string>): boolean {
  const added = [...after].filter((item) => !before.has(item))
  const removed = [...before].filter((item) => !after.has(item))

  for (const item of added) {
    console.log(`  + ${label}: ${item}`)
  }
  for (const item of removed) {
    console.log(`  - ${label}: ${item}`)
  }

  return added.length > 0 || removed.length > 0
}

const response = await fetch(SPEC_URL)
if (!response.ok) {
  console.error(`Could not fetch the spec: ${response.status}`)
  process.exit(1)
}

const remoteText = await response.text()
const remote = JSON.parse(remoteText) as Spec
const local = JSON.parse(await readFile(LOCAL, 'utf8')) as Spec

console.log(`local  version: ${local.info?.version ?? 'unknown'}`)
console.log(`remote version: ${remote.info?.version ?? 'unknown'}`)

let drifted = report('operation', operations(local), operations(remote))
drifted =
  report(
    'schema',
    new Set(Object.keys(local.components?.schemas ?? {})),
    new Set(Object.keys(remote.components?.schemas ?? {}))
  ) || drifted

if (!drifted) {
  console.log('No operations or schemas added or removed.')
}

if (process.argv.includes('--write')) {
  await writeFile(LOCAL, remoteText)
  console.log('Vendored spec updated. Review src/types.ts for field-level changes.')
}
