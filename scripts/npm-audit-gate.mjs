#!/usr/bin/env node
// scripts/npm-audit-gate.mjs — severity gate for the frontend-dep-scan CI job.
//
// `npm audit --audit-level=high` has no ignore list, so an advisory with no
// fix (braces GHSA-vfj7-8cjw-p6xm, #1415) red-walled every nightly run even
// though dep-scan-osv already accepts it. This gate reads `npm audit --json`
// and fails on HIGH/CRITICAL advisories, skipping the ids accepted in
// frontend/osv-scanner.toml — the single source of truth for accepted risks,
// so the two scanners can never disagree. An entry past its `ignoreUntil`
// date stops suppressing, forcing the same reassessment OSV does.
//
// Exit codes: 0 clean, 1 unaccepted HIGH/CRITICAL (or unparseable input), 3 usage.
// Usage: node scripts/npm-audit-gate.mjs <npm-audit.json> [osv-scanner.toml] [today=YYYY-MM-DD]
//        node scripts/npm-audit-gate.mjs --self-test
//   --self-test proves the gate still fires on a known-bad report (#1093): a
//   gate that silently stops detecting looks identical to a clean codebase.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Returns the set of advisory ids still inside their ignoreUntil window.
export function acceptedIds(toml, today) {
  const ids = new Set()
  for (const block of toml.split(/^\[\[IgnoredVulns\]\]/m).slice(1)) {
    const id = block.match(/^\s*id\s*=\s*"([^"]+)"/m)?.[1]
    const until = block.match(/^\s*ignoreUntil\s*=\s*(\d{4}-\d{2}-\d{2})/m)?.[1]
    // No date means accepted indefinitely; ISO dates compare lexically.
    if (id && (!until || until >= today)) ids.add(id)
  }
  return ids
}

// Advisories live in `via` as objects; string entries are transitive pointers.
// Group them by advisory id (the GHSA at the end of the url) so a package that
// is only vulnerable *through* an accepted advisory is not reported.
export function blockingAdvisories(report, accepted) {
  const found = new Map()
  for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== 'object') continue
      if (!['high', 'critical'].includes(via.severity)) continue
      const id = via.url?.split('/').pop() ?? String(via.source)
      if (accepted.has(id)) continue
      found.set(id, `${name}: ${via.title} (${via.severity}, ${id})`)
    }
  }
  return [...found.values()]
}

function selfTest() {
  const adv = (id, severity) => ({
    vulnerabilities: { pkg: { via: [{ source: 1, title: 't', url: `https://github.com/advisories/${id}`, severity }] } },
  })
  const toml = '[[IgnoredVulns]]\nid = "GHSA-accepted"\nignoreUntil = 2026-11-30\n'
  const cases = [
    ['unaccepted critical is flagged', blockingAdvisories(adv('GHSA-bad', 'critical'), acceptedIds(toml, '2026-10-03')).length === 1],
    ['accepted advisory is spared', blockingAdvisories(adv('GHSA-accepted', 'high'), acceptedIds(toml, '2026-10-03')).length === 0],
    ['expired ignore is flagged', blockingAdvisories(adv('GHSA-accepted', 'high'), acceptedIds(toml, '2026-12-01')).length === 1],
    ['moderate is spared', blockingAdvisories(adv('GHSA-mod', 'moderate'), new Set()).length === 0],
  ]
  console.log('=== npm-audit-gate.mjs --self-test ===')
  const failed = cases.filter(([, ok]) => !ok)
  for (const [name, ok] of cases) console.log(`${ok ? 'OK' : 'FAIL'}: ${name}`)
  if (failed.length) {
    console.error(`=== npm-audit-gate.mjs --self-test: FAILED (${failed.length}) ===`)
    process.exit(1)
  }
  console.log('=== npm-audit-gate.mjs --self-test: PASSED ===')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--self-test') {
    selfTest()
    process.exit(0)
  }
  const [auditPath, tomlPath = 'frontend/osv-scanner.toml', today = new Date().toISOString().slice(0, 10)] =
    process.argv.slice(2)
  if (!auditPath) {
    console.error('usage: npm-audit-gate.mjs <npm-audit.json> [osv-scanner.toml] [today]')
    process.exit(3)
  }
  let report
  try {
    report = JSON.parse(readFileSync(auditPath, 'utf8'))
  } catch (e) {
    console.error(`npm-audit-gate: cannot parse ${auditPath}: ${e.message}`)
    process.exit(1) // fail safe: an incomplete scan must block, not pass
  }
  let toml = ''
  try { toml = readFileSync(tomlPath, 'utf8') } catch { /* no accepted risks */ }
  const accepted = acceptedIds(toml, today)
  const blocking = blockingAdvisories(report, accepted)
  if (blocking.length) {
    console.error('npm-audit-gate: unaccepted HIGH/CRITICAL advisories:')
    blocking.forEach((b) => console.error(`  ${b}`))
    process.exit(1)
  }
  console.log(`npm-audit-gate: clean (${accepted.size} accepted advisory id(s) honored)`)
}
