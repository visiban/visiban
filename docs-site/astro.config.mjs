// Visiban docs on Astro + Starlight: a #1271 SPIKE, not the live site.
//
// docs.visiban.com is still built by mkdocs-material + mike from docs/ (see
// mkdocs.yml and the docs-deploy job). Nothing here is deployed. This
// prototype ports docs/getting-started/ (rewritten in Smart Brevity style, see
// docs/development/docs-style-smart-brevity.md) and backfills three released
// versions from their git tags to prove starlight-versions side by side with
// mike. Findings and the go/no-go are in SPIKE-FINDINGS.md.
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import starlightVersions from 'starlight-versions'

// Archived versions, newest first. The dropdown shows them in exactly this
// order: there is no string sort to get wrong, which is the half of #1270 that
// mike's verspec sort caused.
//
// Each slug mirrors the URL mike already publishes (/v1.2/, /v1.1/,
// /v1.2.0-alpha.1/), so a deep link into an archived version keeps working
// after a cutover. Snapshots for releases that predate this site are
// backfilled with `npm run snapshot -- <tag> <slug>`; future releases are cut
// by adding the entry here and running one build (the plugin copies the
// current tree into src/content/docs/<slug>/), then committing the snapshot.
const versions = [
  { slug: 'v1.2', label: 'v1.2' },
  { slug: 'v1.2.0-alpha.1', label: 'v1.2.0-alpha.1 (pre-release)' },
  { slug: 'v1.1', label: 'v1.1' },
]

// The other half of #1270: mike accepted any string as a version, so one
// un-prefixed DOCS_VERSION created a duplicate entry. Refuse a malformed or
// duplicate slug at config load, before anything is written.
const slugPattern = /^v\d+\.\d+(\.\d+-(alpha|beta|rc)\.\d+)?$/
const seen = new Set()
for (const { slug } of versions) {
  if (!slugPattern.test(slug)) {
    throw new Error(`docs version slug "${slug}" must be vMAJOR.MINOR or vMAJOR.MINOR.PATCH-(alpha|beta|rc).N`)
  }
  if (seen.has(slug)) throw new Error(`docs version slug "${slug}" is listed twice`)
  seen.add(slug)
}

export default defineConfig({
  site: 'https://docs.visiban.com',
  integrations: [
    starlight({
      title: 'Visiban',
      description:
        'Open-source Kanban board where every row is an entity and every move is on the record.',
      social: [{ icon: 'gitlab', label: 'GitLab', href: 'https://gitlab.com/visiban/visiban' }],
      editLink: { baseUrl: 'https://gitlab.com/visiban/visiban/-/edit/main/docs-site/' },
      plugins: [starlightVersions({ versions, current: { label: 'Latest (main)' } })],
      // The getting-started path reads top to bottom: decide, install, first
      // boot, set up a board, then branch to what your install needs.
      sidebar: [
        { label: 'Home', link: '/' },
        {
          label: 'Getting Started',
          items: [
            { slug: 'getting-started', label: 'Start here' },
            { slug: 'getting-started/why-visiban' },
            { slug: 'getting-started/installation' },
            { slug: 'getting-started/first-boot' },
            { slug: 'getting-started/board-setup' },
            { slug: 'getting-started/sample-boards' },
            {
              label: 'Branch to what you need',
              items: [
                { slug: 'getting-started/kubernetes' },
                { slug: 'getting-started/oauth' },
                { slug: 'getting-started/onboarding-tour' },
              ],
            },
          ],
        },
      ],
    }),
  ],
})
