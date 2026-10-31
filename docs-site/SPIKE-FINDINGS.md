# Spike #1271: Astro + Starlight as a replacement for mkdocs-material + mike

**Verdict: GO, with five conditions.** Starlight with `starlight-versions` fixes the #1270 bug class at its root, keeps every URL mike published working (the `v1.1`/`v1.2` alias paths unchanged, and all 22 full-version directories plus the `latest`/`next` aliases through redirect rules), and builds this prototype in about 1.3 seconds. The porting work is mostly mechanical, and a converter for it already exists here. The conditions are listed under [Go / no-go](#go--no-go). None of them is large, but skipping any of them would ship a regression.

**Why it matters:** mike appends to a `gh-pages` branch, identifies versions with free-form strings, and sorts them as strings. That design is what let one un-prefixed `DOCS_VERSION` create a duplicate version that outranked every real one (#1270). `starlight-versions` uses a different model. Versions are an explicit, reviewed array in a config file. A version's docs are a snapshot committed at its release tag. Nothing is appended to a branch by CI.

**Scope:** spike only. Nothing here is deployed. `docs-deploy`, the `gh-pages` branch, and the live URLs are untouched. The only change to `mkdocs.yml` is one nav line for the new style guide. Every number below was measured on this branch (base `f0e6cc7a7`, 2026-10-31) unless it says *not measured* or *estimate*. The scripts that measure them are committed in `scripts/` (see [Reproduce the numbers](#reproduce-the-numbers)); rerun them rather than trusting this page.

## What was built

| Path | What it is |
|---|---|
| `astro.config.mjs` | Starlight config: sidebar, version list, version-slug guard |
| `src/content.config.ts` | Content collections, plus a custom `generateId` that keeps dots in version directory names |
| `src/content/docs/index.md`, `getting-started/*` | The current version: `docs/getting-started/` **rewritten** in Smart Brevity style, reordered into one path |
| `src/content/docs/v1.2/`, `v1.2.0-alpha.1/`, `v1.1/` | Archived versions, backfilled from tags `v1.2.0`, `v1.2.0-alpha.1`, and `v1.1.0` |
| `src/content/versions/*.json` | Each archived version's sidebar, taken from that tag's `mkdocs.yml` nav |
| `scripts/snapshot-from-tag.mjs` | The converter: mkdocs Markdown at a git tag → a Starlight version snapshot |
| `public/_redirects` | GitLab Pages redirects for every URL mike published: the 22 full-version directories in `gh-pages/versions.json` and the `latest`/`next` aliases |
| `scripts/check-*.mjs`, `scripts/measure-*.mjs` | The checks and measurements behind this page; see [Reproduce the numbers](#reproduce-the-numbers) |
| `../docs/development/docs-style-smart-brevity.md` | The style guide for the rewrite, with a before/after example |

**Run it:** `cd docs-site && npm ci && npm run build` (Node 22.12+). `npm run dev` serves it at `localhost:4321`. To re-backfill a version, run `npm run snapshot -- <tag> <slug>`, for example `npm run snapshot -- v1.1.0 v1.1`.

**By the numbers:** 40 pages build in 1.3 s with a warm cache, 3.7 s on the first build after `npm ci` (Apple Silicon). That's 10 current pages plus 30 across the three archived versions. `dist/` is 4.1 MB. Three direct dependencies (`astro` 7.3.3, `@astrojs/starlight` 0.41.3, `starlight-versions` 0.9.1), exact-pinned to what TruePPM resolves, with 502 lockfile entries. `osv-scanner` 2.3.8 plus `scripts/osv-severity-gate.sh` on the lockfile: no advisories. `gitleaks dir docs-site`: no leaks. `trivy fs docs-site/package-lock.json --scanners vuln --severity HIGH,CRITICAL` (local trivy 0.71.1; CI pins 0.74.0): clean.

## Versioning, proven side by side with mike

**Result:** Three released versions sit in one dropdown, in a fixed order: **Latest (main)**, `v1.2`, `v1.2.0-alpha.1 (pre-release)`, `v1.1`. Switching versions keeps you on the same page. A version without that page (`why-visiban` doesn't exist in `v1.1`) lands on the 404 page.

**How it works:**

- **The order is the array order** in `astro.config.mjs`. No string sort is involved, so the verspec half of #1270 can't happen.
- **A malformed or duplicate version slug fails config load.** It must match `^v\d+\.\d+(\.\d+-(alpha|beta|rc)\.\d+)?$`. The snapshot script refuses the same pattern (tested: `v1.1x` exits 2). Neither mike nor the plugin validates slugs. The guard lives in our config, so it is ours to keep.
- **The slugs reuse mike's alias paths.** `/v1.2/getting-started/installation/` is the same URL on both sites, so a deep link through mike's `v1.1`/`v1.2` aliases survives a cutover with no redirect rule.
- **mike's full-version URLs need redirects, and have them.** mkdocs-material's version dropdown links to the full-version directories (`/v1.2.0/`, `/v1.1.0/`, `/v1.0.0/`, and every pre-release), not to the aliases, so those are the URLs people bookmarked. `public/_redirects` has a splat rule for each of the 22 directories in `gh-pages`' `versions.json` (checked against that file: 26 of 26 versions and aliases covered). The 1.2 line maps to `/v1.2/:splat` and the 1.1 line to `/v1.1/:splat`, both 301. `latest` maps to the root with 301 and `next` with 302. The 1.0 line maps to the root with 302, because this prototype doesn't backfill `v1.0`; backfill it and repoint those rules if 1.0 docs should stay reachable. *Not tested on GitLab Pages itself:* the rules follow GitLab's documented `_redirects` splat syntax, but no Pages deploy was made.
- **Links out of scope go to the same version on the live site.** In the `v1.1` snapshot, a link to `features/custom-fields.md` becomes `https://docs.visiban.com/v1.1/features/custom-fields/`. That keeps the prototype honest about which pages it has.

**Cutting a new version at a release works.** Tested in a scratch copy: adding `{ slug: 'v1.3' }` and running one build copied the current tree to `src/content/docs/v1.3/`. It also wrote `src/content/versions/v1.3.json`, rewrote all 58 internal links to `/v1.3/...` (0 broken), and built 50 pages. That is the release-time step going forward: add the entry, build once, and commit the snapshot.

**Yes, but: four traps showed up, and each one has a fix.**

1. **Astro strips dots from content directory names.** Its default entry id runs each path segment through github-slugger, so `v1.2/` publishes at `/v12/`, and the plugin, which matches the literal `v1.2`, can't find it. The build fails with *"The slug `v1.2/getting-started` … does not exist"*. **Fix (done here):** a custom `generateId` in `src/content.config.ts`. A version the plugin cuts itself isn't affected, because the plugin writes an explicit `slug:` into each page's front matter. Backfilled snapshots need the `generateId`.
2. **The cut parses every page as MDX, `.md` included.** It uses `remark-mdx`, so an HTML comment, a bare `<word>`, or a `{` in prose aborts the cut. The first cut attempt here died on the `<!-- BEGIN sample-table -->` marker in `sample-boards.md`. **Measured on `docs/` today: 6 of 106 files fail that parse** (`scripts/measure-mdx-parse.mjs`; the line is the offending construct's): `api/boards.md:731`, `changelog.md:6`, `features/board.md:550`, `features/mcp-demo-walkthrough.md:103`, `features/notifications.md:42`, `getting-started/sample-boards.md:37`. **Fix:** make those 6 parse-clean, and replace the generator's HTML-comment markers with `[//]: # "…"` lines (done in the prototype's `sample-boards.md`; the generator itself is a migration task). The snapshot converter now does both conversions for backfilled versions, including escaping bare placeholders such as `<sample title>`, which mkdocs also renders as nothing at all: 0 of 39 prototype pages fail the parse. Then add a CI check that parses every page the way the cut does, so a release can't be the first place this fails.
3. **A failed cut leaves a half-written version on disk.** The aborted run left 8 of 9 pages in `v1.3/` and no `versions/v1.3.json`. **The rerun fails loudly** (*"Failed to read the version 'v1.3' configuration file"*). It doesn't silently ship a partial version, but recovering means deleting the directory by hand. Put that in the release runbook.
4. **The cut re-serializes Markdown.** The `v1.3` snapshot differs from its source by +194/−177 lines across 9 files: wrapped front matter, normalized list markers, and an added `slug:`. The content is the same, but expect a noisy snapshot diff in the release MR, and review it as generated output.

**Not tested:** `starlight-versions`' per-version search scoping on a deployed site (Pagefind indexes at build; the plugin swaps in a version-aware search UI); and an Alpine/musl CI build. The lockfile carries `linuxmusl` binaries for sharp, the Astro compiler, satteri, lightningcss, and rolldown, so musl looks supported, but it is *not measured*.

**TruePPM is not proof of versioning.** `docs.trueppm.com` runs this exact stack, but its `versions` array is empty: versioning is deliberately dormant until its 0.4 tag (see the comment in its `astro.config.mjs`). This spike is the first place `starlight-versions` has actually served versions for either project.

## What porting the full tree costs

**Inventory of `docs/`** (105 pages before this branch, 30,222 lines):

| Construct | Count | Port |
|---|---|---|
| Admonitions `!!! type "Title"` | 298 in 63 files: note 153, warning 102, tip 29, info 8, danger 6. 236 have a custom title, 2 are nested | **Mechanical.** The converter maps them to `:::note/tip/caution/danger[Title]` asides, recursively. `info` becomes `note` and `warning` becomes `caution` (Starlight has no `info`/`warning`). |
| Tabbed blocks `=== "Label"` | 14 in 4 files | **Mechanical.** The page becomes `.mdx` with `<Tabs>/<TabItem>`. Its prose then needs `{`, `}`, and `<` escaped, which the converter does. |
| `include-markdown` | **1 use**: `changelog.md` includes `../CHANGELOG.md` | **Small.** Replace it with an Astro page that imports `CHANGELOG.md`, or a prebuild copy. |
| Nav (`mkdocs.yml`) | 105 page entries (nav lines naming a `.md` file) before this branch, 106 with the style guide; one tree. An earlier draft said 109: that counted every 4-space `- ` line in the whole file, which includes 9 theme lines. | **Hand port, about 1–2 h.** It becomes the `sidebar` array. The converter already reads one section of it. |
| Relative `.md` links | 857 | **Mechanical.** They are rewritten to absolute Starlight paths. All 592 internal links in the built prototype resolve (definition under [Reproduce the numbers](#reproduce-the-numbers)). |
| Front matter | 1 file has any (`changelog.md`, `hide: navigation`) | **Mechanical.** Each page's `# H1` becomes its required `title:`. |
| Heading anchors that change | **78 of 1,388 headings, in 35 files** (1,395 headings with the new style guide, which adds no drift); 18 in-repo links point at one | **Needs care.** mkdocs collapses `" / "` and `" — "` to a single `-`, and Starlight keeps `--` (for example `#kubernetes-helm` → `#kubernetes--helm`). The converter remaps in-repo links. External deep links need an `<a id="old">` shim; `first-boot.md` in the prototype shows one. |
| Pages that break the MDX parse used at version cut | 6 | **Small, but required.** See trap 2. |
| Images, Mermaid fences, fence attributes (`hl_lines`, `title=`), attr lists | 0 / 0 / 0 / 0 | Nothing to port. (The 8 `{:`-shaped grep hits are kubectl `jsonpath` strings inside code.) |
| Non-Markdown files | `requirements.txt`, `googled53d7e4b717185a1.html` | Move the Google site-verification file to `public/`. Delete `requirements.txt` when mike goes. |

**mkdocs-material features in use, and their Starlight equivalents:**

- `content.code.copy`: built in (Expressive Code).
- `navigation.tabs`: becomes sidebar groups, which changes the look. Starlight has no top tab bar.
- `navigation.sections`, `navigation.indexes`, and `navigation.breadcrumbs`: sidebar groups and index pages cover them. Starlight shows no breadcrumbs, a small regression.
- `toc.integrate`: the TOC moves to Starlight's right-hand column.
- `search`: Pagefind is built in.

**Estimate:** about **5–7 working days** for the whole migration, under three assumptions:

- the converter is extended from `getting-started/` to the whole tree (about 1 day)
- each of the 7 sections gets a hand review of the converted output (about half a day each)
- the CI, release, and tooling changes below are about 2 days

This is a planning estimate, *not measured*. It does not include the Smart Brevity rewrite, which is tracked separately.

## gh-pages history: restart, don't port

**By the numbers:** `gh-pages` holds **22 versions in 2,645 files (198.3 MB)**. Only 3 of them are GA releases (`v1.0.0`, `v1.1.0`, `v1.2.0`). The other 19 are pre-releases (`v1.0.0-rc.3` … `v1.2.0-rc.1`). The aliases are `latest`, `next`, `v1.1`, and `v1.2`.

**Recommendation:** start fresh, and keep only GA minors.

- **Backfill `v1.1` and `v1.2`** (and `v1.0` if you want it) from their tags with `scripts/snapshot-from-tag.mjs`. That rebuilds them from source rather than porting rendered HTML.
- **Drop the pre-release versions.** Redirect `/<pre-release>/*` to its minor in `public/_redirects`. A pre-release's docs are superseded by its GA by definition.
- **Keep the `gh-pages` branch, frozen,** for one release cycle as an archive, then delete it.

**Why not port it:** the branch is rendered mkdocs HTML. Nothing in it can be imported into Starlight, and every byte of it is reproducible from the tags.

## CI, deploy, and release surface that changes

**Replaced:**

- **`docs-deploy`** (`python:3.12-slim`, `pip install -r docs/requirements.txt`, `mike deploy --push` to `gh-pages` with `DOCS_DEPLOY_TOKEN`). It becomes a `docs-build` job (`npm ci && npm run build`, artifact `docs-site/dist`) plus a `pages` job that publishes that artifact on `v*` tags and on main.
- **`pages`**, which today runs on the `gh-pages` branch and copies it to `public/`. It becomes the job above.

**Removed or changed:**

- **`DOCS_DEPLOY_TOKEN`** is no longer needed for docs, because nothing pushes a branch. It is **still used by `cleanup-merged-branches`**, so rescope it rather than delete it. Update `docs/maintainers/tokens-and-rotation.md` to match.
- **`scripts/resolve-docs-version.sh`** and its test become obsolete, because the version list is now `astro.config.mjs`. Revisit #1997 (main's docs deploy runs outside the release guard) in the same change, since the deploy trigger moves.
- **The Node toolchain:** Astro 7 needs **Node 22.12+**. Every Node job in `.gitlab-ci.yml` today uses `node:20-alpine`, so the docs job needs its own image.
- **The `docs-deploy` path rules** (`docs/**/*`, `mkdocs.yml`) become `docs-site/**/*`.

**Must be repointed:**

- **`scripts/release.sh` rewrites docs on every release.** It writes `APP_VERSION=` in `docs/getting-started/installation.md`, the `image.tag=` values in `docs/getting-started/kubernetes.md`, and the `!!! warning "Release candidate"` / `!!! note "Latest release"` banner in `docs/index.md`. All three need the new paths and the `:::` aside syntax. The release also gains a "cut the docs version" step (add the entry, build, commit the snapshot) before tagging.
- **`scripts/check-docs-version-accuracy.sh`** scans `docs/**/*.md` and matches the `!!!` banner. It must scan `docs-site/src/content/docs/**/*.md{,x}`, and it must **exclude archived version directories**. A frozen `v1.1/` snapshot legitimately says what was true at 1.1, and the gate would red on it forever.
- **`backend/boards/seed_data/generate_seed_data.py`** writes the sample table into `docs/getting-started/sample-boards.md` between `<!-- BEGIN/END sample-table -->` markers (`TABLE_BEGIN`/`TABLE_END`, line 2017). It needs the new path, and markers that survive the MDX parse (trap 2).
- **`dep-scan-osv`** scans only `backend/requirements.txt` and `frontend/package-lock.json`, so `docs-site/package-lock.json` must be added. `gitleaks-scan` already covers the new tree, and `.gitleaks.toml` already allowlists `package-lock.json`.
- **`trivy-scan` starts scanning `docs-site/package-lock.json` as soon as this branch merges, not at migration.** Its nightly run (`CVE_SCAN=true`) is `trivy fs .` over the whole tree with `--severity HIGH,CRITICAL --exit-code 1` and `allow_failure: false`. A future HIGH advisory against an Astro dependency therefore reds the nightly pipeline even while `docs-site/` is only a prototype. The lockfile is clean today. Its MR trigger is path-scoped and doesn't include `docs-site/`, so this MR doesn't run it.
- **`changelog-check`** exempts `docs/`, `mkdocs.yml`, and `*.md`, but not `docs-site/`. Without a change, every docs-only MR after the migration needs a fragment.

**Must keep working:**

- **`README.md` has 32 links to `docs.visiban.com/next/…`.** `public/_redirects` maps `/next/*` and `/latest/*` to the root.
- **Link checking.** `mkdocs build --strict` fails on a broken link. `astro build` does not. Keep the link check this spike used (a script over `dist/`), or add a link-validator plugin, which is a new dependency and needs the `dependency` gate.

**Prose that still says mike:**

- `docs/maintainers/known-ci-failures.md` (the `mike delete`/`mike alias` recovery runbook)
- `docs/development/ci-gates.md` (the `resolve-docs-version.sh` row)
- `README.md` (`mkdocs serve`)
- `.claude/skills/release/SKILL.md` (lines 286 and 320)

## Agent and skill changes

| File | Today | Change |
|---|---|---|
| `.claude/agents/docs-writer.md` | Line 10: "built with MkDocs Material and versioned with `mike`". Lines 69–74: `!!! tip` / `!!! warning` guidance. Lines 80–90: add pages to the `mkdocs.yml` nav. Lines 115–118: `mkdocs build --strict` | Starlight asides; edit the `sidebar` in `docs-site/astro.config.mjs`; `npm run build` plus the link check; point at the Smart Brevity guide |
| `.claude/agents/api-docs.md` | Line 69: reflect consumer filters "as a `!!! note`". Line 83: "listed in `mkdocs.yml`" | `:::note`; the sidebar config |
| `.claude/skills/release/SKILL.md` | Lines 286 and 320 describe the `mike deploy` and `mike` abandon steps | The version-cut step, and its recovery (trap 3) |
| Project `CLAUDE.md` | "invoke `/docs`", but **no `docs` skill exists** in `.claude/skills/` (it has `ci-debug`, `fix-mr`, `kaizen`, `mass_merge`, `mr`, `pre-release`, `release`, `review`, `threat-model`, `voc`, `wave`) | Point at the `docs-writer` agent, or create the skill. This drift predates the spike. |

## The Smart Brevity rewrite of Getting Started

**What changed:**

- **The section reads as one path.** The order is: decide → install → first boot → board setup → sample boards. Kubernetes, OAuth/SSO, and the onboarding tour sit in a "Branch to what you need" group.
- **Every page opens the same way.** It has a tease-like title, a one-sentence lede, a **Why it matters:** line, and bold-label axioms (**The big picture**, **How it works**, **Yes, but**, **Watch out**, **Go deeper**).
- **Page slugs are unchanged,** so every existing URL still resolves.
- **Every published anchor still resolves: 101 of 101.** The original nine pages published 101 H2–H6 anchors. The first cut of the rewrite (commit `368e2e5df`) renamed or merged headings and broke **45** of them, including `installation#environment-variables`, `#hardware-requirements`, and `#docker-recommended`. Only the 9 that other repo pages link to had been kept. External bookmarks can't be grepped for, so all 101 count. Each of the 45 is now an `<a id="old-anchor"></a>` shim placed where that content lives, and `scripts/check-rewrite-facts.mjs` checks every one against the built page.

**No facts were cut** (checked by `scripts/check-rewrite-facts.mjs`, not by eye). Against the original `docs/getting-started/*.md`, the rewrite is missing 0 code blocks, 0 inline-code tokens (every env var, path, flag, and command), 0 external link targets, and 0 callouts. Callouts are compared by count per severity: the rewrite has at least as many note, tip, caution, and danger asides as the original on every page. All 592 internal links in the built site resolve, anchors included.

**Callouts kept their severity.** The first cut had flattened 11 callouts into prose or bold labels:

- the `warning`s in `board-setup` ("Required for accurate analytics") and `first-boot` (lost temporary password)
- five `note`s in `first-boot` and `installation`
- one `tip` each in `installation` and `kubernetes`
- the two version `note`s in `sample-boards`, which had become blockquotes

All are asides again, at the original severity. The style guide now says a warning is never flattened.

**Yes, but: the pages are not much shorter.** Prose words went from 14,059 to 14,458 across the nine pages (anchor shims excluded):

- **The larger pages lost a little or held steady:** `installation` 4,228 → 4,195, `first-boot` 1,218 → 1,207, and `board-setup` 604 → 604.
- **The small pages grew:** `oauth` 357 → 505, because it gained a provider summary table, and `index` 306 → 414.

On pages that are mostly commands, tables, and warnings, "cut words, never facts" leaves few words to cut. The gain is scannability, not length. That's worth saying before anyone sets a word-count target for the rest of the rewrite.

**One fix found while rewriting:** the original `getting-started/index.md` says "work through these **four** steps" and then lists five. The rewrite says five. The in-place port should carry that fix back.

## Go / no-go

**GO**, conditional on the migration issue taking these five as acceptance criteria:

1. Make the 6 MDX-hostile pages, and the generator markers, parse-clean. Add a CI parse check so a release is never the first place it fails.
2. Keep link checking. `astro build` doesn't fail on broken links the way `mkdocs build --strict` does. `scripts/check-links.mjs` is a dependency-free start.
3. Keep the version-slug guard in `astro.config.mjs`. Neither mike nor the plugin validates slugs.
4. Preserve every published anchor, not only the ones in-repo links use: remap in-repo links, and add `<a id>` shims for the rest.
5. Repoint `release.sh`, `check-docs-version-accuracy.sh` (excluding archived versions), and `generate_seed_data.py`. Add the Node 22 image, and add the lockfile to `dep-scan-osv`.

**Open questions this spike did not evaluate** (both belong to #2019):

- **Mermaid.** `docs/` has no Mermaid today, but Starlight renders none without a plugin, and that needs the `dependency` gate. TruePPM renders at build time with `rehype-mermaid`. That needs Playwright and a headless Chromium in the docs CI image, pinned to the Playwright version, and Astro 7 has to be switched back to the unified Markdown processor for rehype plugins to run (see its `astro.config.mjs`). The alternative is client-side `mermaid.js`, which ships JavaScript to every reader. Pick one before the first diagram lands.
- **OSS plus enterprise docs in one build.** Whether enterprise pages (from `visiban-enterprise`) can be composed into the same Starlight site and sidebar, and how a version cut snapshots content from two repos, was not looked at.

**No-go signals to watch:**

- **`starlight-versions` is pre-1.0,** and its README calls it "still in early development".
- **A single maintainer owns the cut mechanism** (HiDeoo).

If the plugin stalls, the fallback is cheap: archived versions are plain committed directories, so they keep building without the plugin's UI.

## Reproduce the numbers

Run these from `docs-site/` after `npm ci && npm run build`. None needs a new dependency: the two that parse or slug resolve `remark` and `github-slugger` through `starlight-versions`' own dependency tree.

| Script | npm script | Measures | Result on this branch |
|---|---|---|---|
| `scripts/check-rewrite-facts.mjs [section]` | `check:facts` | Old `docs/<section>/` vs. rewritten pages. It compares code blocks, inline code, external links, callouts per severity, and published H2–H6 anchors resolved against the built page. Exits 1 on any loss. | `getting-started`: 0 problems, 101/101 anchors |
| `scripts/check-links.mjs` | `check:links` | Every `<a>` with an `href` starting `/` or `#` inside `<main>…</main>` of every built page must resolve, including the fragment. Starlight's heading self-links are counted and reported separately. Header, sidebar, and footer links, and non-`<a>` hrefs, are excluded. | 592 links (354 heading self-links + 238 written in content), 0 broken |
| `scripts/measure-mdx-parse.mjs [dir…]` | `measure:mdx` | Pages that fail the `remark-mdx` parse `starlight-versions` runs when it cuts a version | `../docs`: 6 of 106; prototype: 0 of 39 |
| `scripts/measure-anchor-drift.mjs [dir]` | `measure:anchors` | H2–H6 anchors whose mkdocs slug differs from Starlight's, and in-repo links that target one | 78 of 1,395 headings in 35 files; 18 links |

**Why the link count changed from an earlier 616.** The first count matched every `href="…"` inside `<main>`, which also caught 24 `<link rel="stylesheet">` tags that Expressive Code emits inside `<main>` (one per page with a code block). Counting only `<a>` elements gives 592. Both counts had 0 broken.

## Follow-ups filed

- **#2019:** the migration, with the five conditions above as acceptance criteria and the 5–7 day estimate. It carries no release tier: whether 1.3 commits to it is the owner's call.
- **Smart Brevity rewrite, one issue per section, all in milestone 1.3:**
    - #2020: port this prototype's Getting Started rewrite back into `docs/getting-started/` and `docs/index.md`
    - #2021: administration
    - #2022: api
    - #2023: architecture
    - #2024: development
    - #2025: features
    - #2026: maintainers

  Each one follows `docs/development/docs-style-smart-brevity.md` and is written in place in `docs/`, so none of them waits on #2019.
