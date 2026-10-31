# Spike #1271: Astro + Starlight as a replacement for mkdocs-material + mike

**Verdict: GO, with five conditions.** Starlight with `starlight-versions` removes the design that produced #1270 (an appended, string-sorted, unvalidated version list), keeps every URL mike published resolving (the `v1.1`/`v1.2` alias paths unchanged, all 22 full-version directories and the `latest`/`next` aliases through redirect rules, and every mike-published heading anchor in the archived versions), and builds this prototype in about 1.3 seconds. The porting work is mostly mechanical, and a converter for it already exists here. The conditions are listed under [Go / no-go](#go--no-go). None of them is large, but skipping any of them would ship a regression. One behavior change needs an owner decision before the cutover: what the site root serves (see [The root and `/latest/`](#the-root-and-latest-a-behavior-change-to-decide)).

**Why it matters:** mike appends to a `gh-pages` branch, identifies versions with free-form strings, and sorts them as strings. That design is what let one un-prefixed `DOCS_VERSION` create a duplicate version that outranked every real one (#1270). `starlight-versions` uses a different model. Versions are an explicit, reviewed array in a config file. A version's docs are a snapshot committed at its release tag. Nothing is appended to a branch by CI.

**Scope:** spike only. Nothing here is deployed. `docs-deploy`, the `gh-pages` branch, and the live URLs are untouched. The only change to `mkdocs.yml` is one nav line for the new style guide. Every number below was measured on this branch (base `f0e6cc7a7`, 2026-10-31) unless it says *not measured* or *estimate*. The scripts that measure them are committed in `scripts/` (see [Reproduce the numbers](#reproduce-the-numbers)); rerun them rather than trusting this page.

## What was built

| Path | What it is |
|---|---|
| `astro.config.mjs` | Starlight config: sidebar, and the version-slug guard applied to the version list |
| `docs-versions.mjs` | The archived versions, newest first, each with the git tag it was cut from |
| `src/content.config.ts` | Content collections, plus a custom `generateId` that keeps dots in version directory names |
| `src/content/docs/index.md`, `getting-started/*` | The current version: `docs/index.md` and `docs/getting-started/` **rewritten** in Smart Brevity style, reordered into one path |
| `src/content/docs/v1.2/`, `v1.2.0-alpha.1/`, `v1.1/` | Archived versions, backfilled from tags `v1.2.0`, `v1.2.0-alpha.1`, and `v1.1.0` |
| `src/content/versions/*.json` | Each archived version's sidebar, taken from that tag's `mkdocs.yml` nav |
| `scripts/snapshot-from-tag.mjs` | The converter: mkdocs Markdown at a git tag → a Starlight version snapshot |
| `public/_redirects` | GitLab Pages redirects for every URL mike published: the 22 full-version directories in `gh-pages/versions.json` and the `latest`/`next` aliases |
| `scripts/version-slugs.mjs` | The version-slug and version-order guard, shared by the config and the converter; `npm run test:versions` tests it |
| `scripts/anchors.mjs` | mkdocs vs. Starlight heading anchors, shared by the converter and the checks |
| `scripts/check-*.mjs`, `scripts/measure-*.mjs` | The checks and measurements behind this page; see [Reproduce the numbers](#reproduce-the-numbers) |
| `../docs/development/docs-style-smart-brevity.md` | The style guide for the rewrite, with a before/after example |

**Run it:** `cd docs-site && npm ci && npm run build` (Node 22.12+). `npm run dev` serves it at `localhost:4321`. To re-backfill a version, run `npm run snapshot -- <tag> <slug>`, for example `npm run snapshot -- v1.1.0 v1.1`.

**By the numbers:** 40 pages build in 1.3 s with a warm cache, and 2.3–3.7 s on a first build after `npm ci` (Apple Silicon). That's 10 current pages (the root plus nine Getting Started pages), 29 across the three archived versions (10 + 10 + 9), and `404.html`. `dist/` is 4.1 MB. Three direct dependencies (`astro` 7.3.3, `@astrojs/starlight` 0.41.3, `starlight-versions` 0.9.1), exact-pinned to what TruePPM resolves, with 502 lockfile entries. `osv-scanner` 2.3.8 plus `scripts/osv-severity-gate.sh` on the lockfile: no advisories. `gitleaks dir docs-site`: no leaks. `trivy fs docs-site/package-lock.json --scanners vuln --severity HIGH,CRITICAL` (local trivy 0.71.1; CI pins 0.74.0): clean.

## Versioning, proven side by side with mike

**Result:** Three released versions sit in one dropdown, in a fixed order: **Latest (main)**, `v1.2`, `v1.2.0-alpha.1 (pre-release)`, `v1.1`. Switching versions keeps you on the same page. A version without that page (`why-visiban` doesn't exist in `v1.1`) lands on the 404 page.

**How it works:**

- **The order is the array order** in `docs-versions.mjs`, which `astro.config.mjs` imports. Nothing sorts it, so the string-sort half of #1270 has nothing to act on. The order is still hand-written, so `scripts/version-slugs.mjs` refuses a list that is not strictly newest-first, compared numerically (`v1.10` ranks above `v1.9`, and a GA minor above its own pre-releases). That makes a misordered list fail the build, not merely unlikely.
- **A malformed or duplicate version slug fails config load.** A slug must be `vMAJOR.MINOR` or `vMAJOR.MINOR.PATCH-(alpha|beta|rc).N` with no leading zeros, so `1.2` (the #1270 shape), `v01.2`, `v1.02`, and `v1.2x` are all refused. The snapshot script applies the same module. `npm run test:versions` runs 9 tests with negative controls: malformed, duplicate, ascending, shuffled, and string-sorted lists, plus a stale `/latest/` redirect. Neither mike nor the plugin validates slugs or order, so this guard is ours to keep. It reduces the #1270 risk to whatever the tested pattern misses; it doesn't eliminate it.
- **The slugs reuse mike's alias paths, and the archived pages keep mike's anchors.** `/v1.2/getting-started/installation/` is the same URL on both sites, so a deep link through mike's `v1.1`/`v1.2` aliases needs no redirect rule. The heading anchors survive too. The converter leaves an `<a id>` shim wherever Starlight's id for a heading differs from the one mike published, including the duplicate-heading class (`#prerequisites_1` vs `#prerequisites-1`). `scripts/check-version-anchors.mjs` checks each version in `docs-versions.mjs` against the built site. Its expected ids are the ones mike actually published: it reads them from the `gh-pages` HTML for the version's tag when that branch is fetched, and models them otherwise. Against the real `gh-pages` HTML:

- `v1.2`: 103/103
- `v1.2.0-alpha.1`: 94/94
- `v1.1`: 70 of 76 resolve, 0 broken

**The 6 unresolved `v1.1` anchors are not a converter bug.** The published `/v1.1.0/` pages carry 6 headings, including `kubernetes#pod-security` and `#bundled-valkey`, that the `v1.1.0` tag's Markdown doesn't have. So what mike published under v1.1.0 was rendered from a later source than the tag. (`docs-deploy`'s main rule deploys main's `docs/` into the version it resolves from `.env.example`. That can do it, but the exact deploy wasn't traced: only the newest 400 `gh-pages` commits were fetched.) A snapshot rebuilt from the tag can't contain those sections. Decide in #2019 whether to backfill from the tag (the release as tagged) or from the last commit mike deployed into each version (the release as published).
- **mike's full-version URLs need redirects, and have them.** mkdocs-material's version dropdown links to the full-version directories (`/v1.2.0/`, `/v1.1.0/`, `/v1.0.0/`, and every pre-release), not to the aliases, so those are the URLs people bookmarked. `public/_redirects` has a splat rule for each of the 22 directories in `gh-pages`' `versions.json` (checked against that file: 26 of 26 versions and aliases covered). The 1.2 line maps to `/v1.2/:splat` and the 1.1 line to `/v1.1/:splat`, both 301. The floating aliases are 302: `latest` goes to the newest GA version (`/v1.2/:splat`), which keeps today's meaning, and `next` goes to the root. The 1.0 line maps to the root with 302, because this prototype doesn't backfill `v1.0`; backfill it and repoint those rules if 1.0 docs should stay reachable. *Not tested on GitLab Pages itself:* the rules follow GitLab's documented `_redirects` splat syntax, but no Pages deploy was made.
- **Links out of scope go to the same version on the live site.** In the `v1.1` snapshot, a link to `features/custom-fields.md` becomes `https://docs.visiban.com/v1.1/features/custom-fields/`. That keeps the prototype honest about which pages it has.

**Cutting a new version at a release works.** Tested in a scratch copy: adding `{ slug: 'v1.3' }` and running one build copied the current tree to `src/content/docs/v1.3/`. It also wrote `src/content/versions/v1.3.json`, rewrote all 58 internal links to `/v1.3/...` (0 broken), and built 50 pages. The release-time steps going forward:

1. Add the entry at the top of `docs-versions.mjs`, with its tag.
2. Build once, and commit the snapshot.
3. If it's a new GA minor, move the `/latest/*` rule in `public/_redirects` to it. `npm run test:versions` fails until you do.

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
| Relative `.md` links | 853. The pattern is a Markdown link whose target ends in `.md` with an optional `#anchor`, excluding `http(s):` targets. An earlier draft said 857, which also counted 4 absolute GitLab links to `.md` files. | **Mechanical.** They are rewritten to absolute Starlight paths. All 598 internal links in the built prototype resolve (definition under [Reproduce the numbers](#reproduce-the-numbers)). |
| Front matter | 1 file has any (`changelog.md`, `hide: navigation`) | **Mechanical.** Each page's `# H1` becomes its required `title:`. |
| Heading anchors that change | **88 of 1,388 headings, in 37 files** (1,395 headings with the new style guide, which adds no drift). 78 are punctuation and 10 are duplicate headings, in 5 files. 22 in-repo links point at one. These numbers come from an anchor model checked against a real `mkdocs build`: 1,395 of 1,395 ids match (`npm run test:anchors`). Two earlier figures were wrong:

- An earlier draft said 78 because it missed the duplicate-heading class.
- The model behind both earlier figures stripped underscores, so `## DJANGO_SECRET_KEY` modeled as `#djangosecretkey` instead of `#django_secret_key`. It got 88 ids wrong against the real build, and its link count was 18.

The drift total held at 88 because both slugifiers keep underscores, so that bug moved no heading into or out of the drift set. | **Mechanical, now.** Punctuation: mkdocs collapses `" / "` and `" — "` to a single `-`, and Starlight keeps `--` (`#kubernetes-helm` → `#kubernetes--helm`). Duplicates: mkdocs suffixes `_1`, Starlight `-1`. The converter remaps in-repo links *and* shims every drifting anchor with `<a id>`, because bookmarks and outside links can't be remapped. |
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

- **`scripts/release.sh` rewrites docs on every release.** It writes `APP_VERSION=` in `docs/getting-started/installation.md`, the `image.tag=` values in `docs/getting-started/kubernetes.md`, and the `!!! warning "Release candidate"` / `!!! note "Latest release"` banner in `docs/index.md`. All three need the new paths and the `:::` aside syntax. The release also gains a "cut the docs version" step before tagging: add the entry to `docs-versions.mjs`, build, and commit the snapshot. For a new GA minor, it also moves the `/latest/*` redirect.
- **`scripts/check-docs-version-accuracy.sh`** scans `docs/**/*.md` and matches the `!!!` banner. It must scan `docs-site/src/content/docs/**/*.md{,x}`, and it must **exclude archived version directories**. A frozen `v1.1/` snapshot legitimately says what was true at 1.1, and the gate would red on it forever.
- **`backend/boards/seed_data/generate_seed_data.py`** writes the sample table into `docs/getting-started/sample-boards.md` between `<!-- BEGIN/END sample-table -->` markers (`TABLE_BEGIN`/`TABLE_END`, line 2017). It needs the new path, and markers that survive the MDX parse (trap 2).
- **`dep-scan-osv`** scans only `backend/requirements.txt` and `frontend/package-lock.json`, so `docs-site/package-lock.json` must be added. `gitleaks-scan` already covers the new tree, and `.gitleaks.toml` already allowlists `package-lock.json`.
- **`trivy-scan` starts scanning `docs-site/package-lock.json` as soon as this branch merges, not at migration.** Its nightly run (`CVE_SCAN=true`) is `trivy fs .` over the whole tree with `--severity HIGH,CRITICAL --exit-code 1` and `allow_failure: false`. A future HIGH advisory against an Astro dependency therefore reds the nightly pipeline even while `docs-site/` is only a prototype. The lockfile is clean today. Its MR trigger is path-scoped and doesn't include `docs-site/`, so this MR doesn't run it.
- **`changelog-check`** exempts `docs/`, `mkdocs.yml`, and `*.md`, but not `docs-site/`. Without a change, every docs-only MR after the migration needs a fragment.

**Must keep working:**

- **`README.md` has 32 links to `docs.visiban.com/next/…`.** `public/_redirects` maps `/next/*` to the root and `/latest/*` to the newest GA version.
- **What `/` and `/latest/` serve.** This is a behavior change, and it needs a decision; see the next section.
- **Link checking.** `mkdocs build --strict` fails on a broken link. `astro build` does not. Keep the link check this spike used (a script over `dist/`), or add a link-validator plugin, which is a new dependency and needs the `dependency` gate.

**Still tied to mike or mkdocs:**

- `docs/maintainers/known-ci-failures.md` (the `mike delete`/`mike alias` recovery runbook)
- `docs/development/ci-gates.md` (the `resolve-docs-version.sh` row)
- `docs/architecture/overview.md` lines 108–121: the CI pipeline diagram's `docs-deploy` box ("mike deploy to gh-pages; stable → latest, pre-release → next"), and the "Docs versioned with mike" design-decision bullet
- `SKILLS.md` line 107: the `docs` skill entry ("updates `mkdocs.yml` nav, enforces … MkDocs admonition syntax, and verifies the build with `mkdocs build --strict`"). That skill doesn't exist in `.claude/skills/` either; see [Agent and skill changes](#agent-and-skill-changes).
- `README.md` (`mkdocs serve`)
- `.claude/skills/release/SKILL.md` (lines 286 and 320)

**License checking doesn't cover `docs-site/`.** Two jobs exist today, and both are `allow_failure: true`:

- `backend-license-check`: `pip-licenses --fail-on` GPLv2/GPLv3 on `backend/requirements.txt`
- `frontend-license-check`: `npx license-checker --failOn "GPL-2.0;GPL-3.0"` in `frontend/`

Neither runs on `docs-site/`. The project `CLAUDE.md` requires enterprise dependencies to pass "the same GPL license checks as OSS deps", so the migration should add a `docs-site` license job alongside the others.

**What the policy says about the 14 LGPL-3.0-or-later lockfile entries** (sharp's prebuilt libvips binaries, all optional and platform-specific):

- **CI blocks only GPL-2.0 and GPL-3.0,** and only as a warning. LGPL isn't on that list.
- **The `dependency` agent** (`.claude/agents/dependency.md` line 28) classes LGPL and MPL as weak copyleft: "generally safe for application use (not library distribution); flag for awareness".
- **`SKILLS.md`** says the dependency gate "blocks GPL-2.0/3.0".

So LGPL is allowed under the project's written rules, and flagged for awareness.

**Measured, not assumed:** CI's exact frontend command, `npx license-checker@25.0.1 --failOn "GPL-2.0;GPL-3.0" --summary`, run in `docs-site/`, exits 0. It counted only the packages installed on this macOS machine: 1 `LGPL-3.0-or-later` package, 1 `Apache-2.0 AND LGPL-3.0-or-later AND MIT` package, and the private root package as `UNLICENSED`. Its `failOn` matching doesn't treat `LGPL-3.0-or-later` as `GPL-3.0`. A Linux CI install would pull the linux libvips variants instead; that run was *not measured*.

## The root and `/latest/`: a behavior change to decide

**Today:**

- `mkdocs.yml` sets `default: latest`.
- `docs-deploy` runs `mike set-default` to the newest GA minor.
- `gh-pages`' root `index.html` redirects to `v1.2/`.

So `docs.visiban.com/` and `/latest/` both show **the newest GA release's docs**.

**Under `starlight-versions`,** the root serves the *current* tree, which is built from main. That's unreleased docs, labeled "Latest (main)" in this prototype.

**Why it matters:** The app's help link points at the root: `frontend/src/components/Layout/UserMenu.tsx` line 144, `href="https://docs.visiban.com"`. A self-hoster on 1.2 who clicks Help would land on docs for features their install doesn't have yet.

**Options. The owner decides; this spike doesn't:**

- **(a) Root = newest GA; main under `/next/`.** This preserves today's behavior. Build the current tree only at release tags so it matches the newest GA, and publish main's build as a separate preview under `/next/`. Recommended, because nothing users rely on changes.
- **(b) Root = main** (TruePPM's model). Every merge is visible immediately, but the help link and every unversioned bookmark show unreleased docs. Only versioned URLs (`/v1.2/…`) pin a release.

**In the prototype:** `/latest/*` is a 302 to `/v1.2/:splat`, which is today's meaning under either option. `/next/*` is a 302 to the root. Change both once the decision is made. This is recorded in #2019.

## Agent and skill changes

| File | Today | Change |
|---|---|---|
| `.claude/agents/docs-writer.md` | Line 10: "built with MkDocs Material and versioned with `mike`". Lines 69–74: `!!! tip` / `!!! warning` guidance. Lines 80–90: add pages to the `mkdocs.yml` nav. Lines 115–118: `mkdocs build --strict` | Starlight asides; edit the `sidebar` in `docs-site/astro.config.mjs`; `npm run build` plus the link check; point at the Smart Brevity guide |
| `.claude/agents/api-docs.md` | Line 69: reflect consumer filters "as a `!!! note`". Line 83: "listed in `mkdocs.yml`" | `:::note`; the sidebar config |
| `.claude/skills/release/SKILL.md` | Lines 286 and 320 describe the `mike deploy` and `mike` abandon steps | The version-cut step, and its recovery (trap 3) |
| Project `CLAUDE.md` | "invoke `/docs`", but **no `docs` skill exists** in `.claude/skills/` (it has `ci-debug`, `fix-mr`, `kaizen`, `mass_merge`, `mr`, `pre-release`, `release`, `review`, `threat-model`, `voc`, `wave`) | Point at the `docs-writer` agent, or create the skill. This drift predates the spike. |

## The Smart Brevity rewrite of the root page and Getting Started

**What changed:**

- **The section reads as one path.** The order is: decide → install → first boot → board setup → sample boards. Kubernetes, OAuth/SSO, and the onboarding tour sit in a "Branch to what you need" group.
- **Every page opens the same way.** It has a tease-like title, a one-sentence lede, a **Why it matters:** line, and bold-label axioms (**The big picture**, **How it works**, **Yes, but**, **Watch out**, **Go deeper**).
- **Page slugs are unchanged,** so every existing URL still resolves.
- **Every published anchor still resolves: 103 of 103.** These are the root page's 2 plus Getting Started's 101. The original nine Getting Started pages published 101 H2–H6 anchors. The first cut of the rewrite (commit `368e2e5df`) renamed or merged headings and broke **45** of them, including `installation#environment-variables`, `#hardware-requirements`, and `#docker-recommended`. Only the 9 that other repo pages link to had been kept. External bookmarks can't be grepped for, so all 101 count. Each of the 45 is now an `<a id="old-anchor"></a>` shim placed where that content lives, and `scripts/check-rewrite-facts.mjs` checks every one against the built page.

**No facts were cut** (checked by `scripts/check-rewrite-facts.mjs`, not by eye). Against the original `docs/index.md` and `docs/getting-started/*.md`, the rewrite is missing none of these:

- code blocks
- inline-code tokens (every env var, path, flag, and command)
- external link targets
- internal link targets, compared as page + anchor
- callouts, compared by count per severity
- blockquote callout labels (`> **Added in 1.2**`, `> **Tested:**`, `> **⚠ Destructive:**`)
- every bullet's bold lead term (for example **Invite links**, **Groups**)
- number phrases in list items and table rows ("five roles", "10 MB")
- version notes, including the `*(1.2)*` and `*(1.2, off by default)*` forms

All 598 internal links in the built site resolve, anchors included.

**The check fails when it should.** `npm run test:facts` runs 19 tests against the real root-page rewrite: a baseline and 18 negative controls. The version-badge controls are described under [Version badges](#version-badges). Each one deletes the Invite links, Custom fields *(1.2)*, Groups, MCP *(1.2, off by default)* or Saved filters bullet, or changes "Five roles" to "Several roles", or drops a version note, a Quick links row, a warning callout, or a duplicate-heading anchor, or hides a broken `#django_secret_key` behind a wrong shim. Every one is reported, and in the right category.

**What it can't see, and a reviewer must read for:** a fact stated only in plain prose. If it isn't code, a link, a callout, a bold bullet term, a number in a list or table, or a version note, the check can't tell whether it was reworded into something false or dropped.

**Two review rounds caught what the first version of the check missed:**

- **The root page.** The first cut reduced `docs/index.md`'s 18-item Highlights list and 10-link Quick links table to three bullets. Lost along the way: the TLS modes, `docker-compose.prod.yml` and `init-prod.sh`, five roles, soft/hard WIP limits, Analytics *(beta)*, PAT scopes, the MCP server being off by default, Trello import, invite links, saved filters, and the "Latest release" note. All are restored, and the check now covers the root page.
- **Two internal links:** `installation#updating-to-a-new-version` and `sample-boards#how-to-import`. Both are restored, and internal links are now checked.

**Callouts kept their severity.** The first cut had flattened 11 callouts into prose or bold labels:

- the `warning`s in `board-setup` ("Required for accurate analytics") and `first-boot` (lost temporary password)
- five `note`s in `first-boot` and `installation`
- one `tip` each in `installation` and `kubernetes`
- the two version `note`s in `sample-boards`, which had become blockquotes

All are asides again, at the original severity. The style guide now says a warning is never flattened.

**Yes, but: the pages are not much shorter.** Prose words went from 14,673 to 15,191 (a version badge counts as one word) across the ten pages (anchor shims excluded):

- **The larger pages lost a little or held steady:** `installation` 4,228 → 4,199, `first-boot` 1,218 → 1,207, and `board-setup` 604 → 605.
- **The small pages grew:** `oauth` 357 → 505, because it gained a provider summary table, `getting-started/index` 306 → 413, and the root page 614 → 731, which gained the prototype notice and a lede.

On pages that are mostly commands, tables, and warnings, "cut words, never facts" leaves few words to cut. The gain is scannability, not length. That's worth saying before anyone sets a word-count target for the rest of the rewrite.

**One fix found while rewriting:** the original `getting-started/index.md` says "work through these **four** steps" and then lists five. The rewrite says five. The in-place port should carry that fix back.

## Version badges

**Features and sections added after 1.0 now carry a visible "added in" badge,** `1.2+`. That is the user's convention, and the rules are in `docs/development/docs-style-smart-brevity.md` under "Version badges". In short: badge a called-out feature or section, never a sentence, and never 1.0.

**What you'll see:**

- **On the root page:** a `1.2+` badge after the bold term of the **Custom fields**, **Trello import**, and **MCP server** Highlights bullets. "Off by default" stays plain text beside the MCP badge.
- **On `installation`:** `1.2+` after the bold label **Verify the images:**, replacing the standalone `> **Added in 1.2**` blockquote above it.
- **On `sample-boards`:** `1.2+` alone under the "From the app" heading, replacing the "Added in 1.2" note about the sample gallery.
- **On `onboarding-tour`:** `1.1+` on the page's first line, replacing `> **Added in 1.1**`, plus a `1.1+` badge on its sidebar entry.

**Version mentions inside sentences stay prose,** as they were:

- "scopes are new in 1.2"
- `first-boot`'s "*(1.2+)* a group invite" and "new in 1.2, via `POST …`"
- `kubernetes`' "Since 1.2, the chart is published …" and "*(since 1.2)* each platform image …"
- `why-visiban`'s "*(as of 1.2)*"

**Behavior changes keep their prose and get no badge.** Those are "Since 1.2, `backend.email.backend` defaults to unset", the "Changed in 1.2" note, and the "removed in 1.1" aliases. Code blocks and the archived snapshots are untouched.

**How it's built:**

- **A plain `<span class="vb-version" title="Added in 1.2">1.2+</span>`**, styled by `src/styles/version-badge.css` (added to `customCss`), using Starlight's blue tokens so it reads in both themes.
- **Why not Starlight's `<Badge>` component:** that only works in `.mdx`. A span keeps every page `.md`, adds no dependency, and parses as MDX at a version cut (`measure:mdx` 0 of 39).
- **No route or anchor impact:** badges never go in heading text (`check:facts` 103/103, `check:version-anchors` unchanged).

**How it's checked:** `check:facts` treats feature-level and prose notes differently.

- **Feature-level notes** (standalone "Added in X" blockquotes or callouts, notes right after a bullet's bold term, and notes in headings) may become badges, counted per version. A dropped badge, or `1.2+` changed to `1.1+`, is reported.
- **Prose notes** must survive word for word.
- **Every badge** must be well formed and newer than 1.0, and it may not sit inside a sentence.
- **The tests:** `test:facts` has negative controls for each of these.

## Go / no-go

**GO**, conditional on the migration issue taking these five as acceptance criteria:

1. Make the 6 MDX-hostile pages, and the generator markers, parse-clean. Add a CI parse check so a release is never the first place it fails.
2. Keep link checking. `astro build` doesn't fail on broken links the way `mkdocs build --strict` does. `scripts/check-links.mjs` is a dependency-free start.
3. Keep the version-slug and version-order guard (`scripts/version-slugs.mjs`, tested by `npm run test:versions`). Neither mike nor the plugin validates slugs or order.
4. Preserve every published anchor, not only the ones in-repo links use: remap in-repo links, and add `<a id>` shims for the rest. That includes the duplicate-heading `_N` class, and every archived version (`check:version-anchors`).
5. Repoint `release.sh`, `check-docs-version-accuracy.sh` (excluding archived versions), and `generate_seed_data.py`. Add the Node 22 image, add the lockfile to `dep-scan-osv`, and add a `docs-site` license job.

**Open questions this spike did not evaluate** (both belong to #2019):

- **Mermaid.** `docs/` has no Mermaid today, but Starlight renders none without a plugin, and that needs the `dependency` gate. TruePPM renders at build time with `rehype-mermaid`. That needs Playwright and a headless Chromium in the docs CI image, pinned to the Playwright version, and Astro 7 has to be switched back to the unified Markdown processor for rehype plugins to run (see its `astro.config.mjs`). The alternative is client-side `mermaid.js`, which ships JavaScript to every reader. Pick one before the first diagram lands.
- **OSS plus enterprise docs in one build.** Whether enterprise pages (from `visiban-enterprise`) can be composed into the same Starlight site and sidebar, and how a version cut snapshots content from two repos, was not looked at.

**No-go signals to watch:**

- **`starlight-versions` is pre-1.0,** and its README calls it "still in early development".
- **A single maintainer owns the cut mechanism** (HiDeoo).

If the plugin stalls, the fallback is cheap: archived versions are plain committed directories, so they keep building without the plugin's UI.

## Reproduce the numbers

Run these from `docs-site/` after `npm ci && npm run build`. `npm test` runs the three `test:` scripts. None needs a new dependency: the two that parse or slug resolve `remark` and `github-slugger` through `starlight-versions`' own dependency tree.

| Script | npm script | Measures | Result on this branch |
|---|---|---|---|
| `scripts/check-rewrite-facts.mjs [section…]` | `check:facts` | Prototype mode: old `docs/` page vs. its rewrite in `src/content/docs/`, with anchors resolved against the built page. With no section, it checks the root page and `getting-started`. The compared kinds of fact, and what isn't checked, are listed in `scripts/rewrite-facts.mjs`. Exits 1 on any loss. | 0 problems; 103/103 anchors |
| `scripts/check-rewrite-facts.mjs --base <ref> <section…>` | — | In-place mode, for rewrites done in `docs/` itself (#2020–#2026). It runs the same comparisons, with `docs/<section>` at `<ref>` as the old page and the working tree as the new one. Anchors come from the new Markdown's headings and `<a id>` shims, so no build is needed. | Control that can fail: `--base v1.1.0 getting-started` compares 1.1's pages with today's and reports 39 problems. The mutation controls are in `test:facts`. |
| `scripts/check-version-anchors.mjs` | `check:version-anchors` | For each version in `docs-versions.mjs`: every anchor mike published (read from `gh-pages` HTML when fetched, modeled otherwise) for each backfilled page must exist in `dist/<slug>/`. Anchors whose heading isn't in the tag's source are reported apart. | `v1.2` 103/103, `v1.2.0-alpha.1` 94/94, `v1.1` 70/76 with 6 not in the tag; 0 broken |
| `scripts/check-links.mjs` | `check:links` | Every `<a>` with an `href` starting `/` or `#` inside `<main>…</main>` of every built page must resolve, including the fragment. Starlight's heading self-links are counted and reported separately. Header, sidebar, and footer links, and non-`<a>` hrefs, are excluded. | 598 links (356 heading self-links + 242 written in content), 0 broken |
| `scripts/test-version-slugs.mjs` | `test:versions` | The slug and order guard, and that `/latest/*` in `_redirects` points at the newest GA version, with negative controls | 9 tests pass |
| `scripts/test-anchor-model.mjs` | `test:anchors` | The anchor model against every heading id a real `mkdocs build` published (`scripts/fixtures/mkdocs-anchor-ids.json`, regenerated by `build-anchor-fixture.mjs`), plus negative controls | 1,395/1,395 match |
| `scripts/test-rewrite-facts.mjs` | `test:facts` | Negative controls for the fact check, including the version badges (see above) | 19 tests pass |
| `scripts/measure-mdx-parse.mjs [dir…]` | `measure:mdx` | Pages that fail the `remark-mdx` parse `starlight-versions` runs when it cuts a version | `../docs`: 6 of 106; prototype: 0 of 39 |
| `scripts/measure-anchor-drift.mjs [dir]` | `measure:anchors` | H2–H6 anchors whose mkdocs id differs from Starlight's, by class, and in-repo links that target one | 88 of 1,395 headings in 37 files (78 punctuation, 10 duplicate in 5 files); 22 links |

**Why the link count changed twice.** The first count, 616, matched every `href="…"` inside `<main>`. That also caught 24 `<link rel="stylesheet">` tags that Expressive Code emits inside `<main>`, one per page with a code block. Counting only `<a>` elements gave 592 at commit `9b1bb4833`. It is 598 now, because the restored root page and the two restored internal links add 6. Every count had 0 broken.

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
