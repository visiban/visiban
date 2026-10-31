// Docs version slugs: one definition, used by astro.config.mjs, the snapshot
// script, and their tests (#1271).
//
// Why this exists: mike accepted any string as a version and sorted the list
// as strings, so one un-prefixed DOCS_VERSION became a duplicate entry that
// outranked every real version (#1270). starlight-versions validates neither
// the slug nor the order, so both checks live here, and the config refuses to
// load when either fails.
//
// A slug is either a GA minor line, `vMAJOR.MINOR` (for example v1.2), or one
// pre-release, `vMAJOR.MINOR.PATCH-(alpha|beta|rc).N` (for example
// v1.2.0-alpha.1). Numeric parts have no leading zeros, so v01.2 and v1.02
// (which a string comparison would treat as distinct from v1.2) are refused.

const num = '(0|[1-9]\\d*)'
export const SLUG_PATTERN = new RegExp(`^v${num}\\.${num}(?:\\.${num}-(alpha|beta|rc)\\.${num})?$`)

const preRank = { alpha: 0, beta: 1, rc: 2 }

/** Sort key: a GA minor line ranks above every pre-release of that minor. */
export function slugKey(slug) {
  const m = SLUG_PATTERN.exec(slug)
  if (!m) return null
  const [, major, minor, patch, kind, n] = m
  return kind
    ? [Number(major), Number(minor), 0, Number(patch), preRank[kind], Number(n)]
    : [Number(major), Number(minor), 1, 0, 0, 0]
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/**
 * Throws unless every slug is well formed, unique, and the list is in
 * strictly descending order (newest first, which is the order the version
 * dropdown shows them in).
 */
export function assertVersions(versions) {
  const keys = versions.map(({ slug }) => {
    const key = slugKey(slug)
    if (!key) {
      throw new Error(
        `docs version slug "${slug}" must be vMAJOR.MINOR or vMAJOR.MINOR.PATCH-(alpha|beta|rc).N, with no leading zeros`,
      )
    }
    return key
  })
  for (let i = 1; i < versions.length; i++) {
    const c = compare(keys[i - 1], keys[i])
    if (c === 0) throw new Error(`docs version slug "${versions[i].slug}" is listed twice`)
    if (c < 0) {
      throw new Error(
        `docs versions must be newest first: "${versions[i - 1].slug}" is listed before the newer "${versions[i].slug}"`,
      )
    }
  }
}
