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
import { assertVersions } from './scripts/version-slugs.mjs'
import { versions } from './docs-versions.mjs'

// Archived versions live in docs-versions.mjs (newest first, with the tag
// each was cut from). The dropdown shows them in exactly that order: nothing
// sorts them, which removes the string-sort half of #1270.
//
// The other half of #1270: mike accepted any string as a version, so one
// un-prefixed DOCS_VERSION created a duplicate entry. Refuse a malformed,
// duplicate, or out-of-order slug at config load, before anything is written.
// Tested, with negative controls, by `npm run test:versions`.
assertVersions(versions)

export default defineConfig({
  site: 'https://docs.visiban.com',
  integrations: [
    starlight({
      title: 'Visiban',
      description:
        'Open-source Kanban board where every row is an entity and every move is on the record.',
      social: [{ icon: 'gitlab', label: 'GitLab', href: 'https://gitlab.com/visiban/visiban' }],
      editLink: { baseUrl: 'https://gitlab.com/visiban/visiban/-/edit/main/docs-site/' },
      // .vb-version: the inline "added in" badge (a plain <span>, so pages can
      // stay .md, and it parses as MDX when starlight-versions cuts a version).
      customCss: ['./src/styles/version-badge.css'],
      plugins: [starlightVersions({ versions: versions.map(({ slug, label }) => ({ slug, label })), current: { label: 'Latest (main)' } })],
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
                // Version badges mark what a page or option was added in; see
                // docs/development/docs-style-smart-brevity.md ("Version badges").
                { slug: 'getting-started/onboarding-tour', badge: { text: '1.1+', variant: 'note' } },
              ],
            },
          ],
        },
      ],
    }),
  ],
})
