import { defineCollection } from 'astro:content'
import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'
import { docsVersionsLoader } from 'starlight-versions/loader'

// Astro's default entry id runs every path segment through github-slugger,
// which deletes dots: src/content/docs/v1.2/ would publish at /v12/ and the
// versions plugin (which matches the literal slug "v1.2") would not find it.
// Keeping the dots is what lets the archived versions reuse mike's existing
// /v1.2/ and /v1.1/ URLs. Every other segment is slugged the way the default
// does for our kebab-case file names: lowercased, spaces to '-', punctuation
// other than '.', '-' and '_' removed.
function generateId({ entry, data }: { entry: string; data: Record<string, unknown> }): string {
  if (typeof data.slug === 'string') return data.slug
  const id = entry
    .replace(/\.(md|mdx)$/, '')
    .split('/')
    .map((segment) =>
      segment
        .toLowerCase()
        .replace(/ /g, '-')
        .replace(/[^\p{L}\p{N}._-]/gu, ''),
    )
    .join('/')
    .replace(/\/index$/, '')
  // The site root keeps the id "index", as Astro's default does.
  return id
}

export const collections = {
  docs: defineCollection({ loader: docsLoader({ generateId }), schema: docsSchema() }),
  // One JSON file per archived version (src/content/versions/<slug>.json),
  // holding that version's sidebar as it was when the version was cut.
  versions: defineCollection({ loader: docsVersionsLoader() }),
}
