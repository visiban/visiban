// The archived docs versions, newest first (#1271). One list, read by
// astro.config.mjs, scripts/check-version-anchors.mjs and the tests.
//
// slug   the URL segment, and the snapshot directory under src/content/docs/.
//        It reuses mike's alias path (/v1.2/, /v1.1/) or version directory
//        (/v1.2.0-alpha.1/); mike's other paths redirect via public/_redirects.
// label  what the version dropdown shows.
// tag    the git tag the snapshot was cut or backfilled from.
//
// Order is the dropdown order and is not sorted by anything; the slug guard
// (scripts/version-slugs.mjs) refuses it unless it is strictly newest-first.
//
// When a new minor is cut: add its entry at the top, build once (the plugin
// snapshots the current tree), commit the snapshot, and move the /latest/*
// rule in public/_redirects to the new minor (npm run test:versions fails
// until you do).
export const versions = [
  { slug: 'v1.2', label: 'v1.2', tag: 'v1.2.0' },
  { slug: 'v1.2.0-alpha.1', label: 'v1.2.0-alpha.1 (pre-release)', tag: 'v1.2.0-alpha.1' },
  { slug: 'v1.1', label: 'v1.1', tag: 'v1.1.0' },
]
