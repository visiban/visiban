---
name: dotplanning
description: Plan a Visiban dot-release milestone BEFORE any development starts. Resolves the milestone scope, asks the kickoff questions that decide the release's shape (charter, date-vs-scope, capacity, reserve, maturity, freeze), builds a feature→asset map, flags every missing screen/flow/endpoint/model/event/doc that has no issue or design, surfaces the decisions that must be answered before coding, sequences the work into gated workstreams, runs a first grooming pass proposing a `release::committed` / `reserve` / `stretch` label for every milestone issue against stated capacity, records the plan on a `Plan: <v>` issue, and drops a self-contained HTML report in ~/Downloads. The begin-gate bookend to /pre-release (the end-gate). Run once at milestone kickoff — not per feature.
disable-model-invocation: true
argument-hint: "[version] [--no-file] [--no-apply]"
---

# Release Planning — Kickoff Gate

Turn a loose milestone (a roadmap headline plus a pile of issues) into a full, sequenced,
gap-checked plan **before the first feature branch exists**. `/pre-release` is the
**end-gate** that audits what shipped; `/dotplanning` is the **begin-gate** that
plans what's about to be built.

**One-time gate, not a loop.** Run this **once** at the start of a milestone. It
produces a plan; it does not write code, run per-feature gates, or re-run after every
decision. Re-run only on a deliberate, material change of scope.

Ported from Blueprint (`macrodream/blueprint`, `.claude/skills/dotplanning/`) and adapted:
Visiban uses the scoped `release::committed` / `release::reserve` / `release::stretch`
labels on every milestone (definitions in each label's GitLab description), has no
`docs/specs/`, and keeps its personas inline in `CLAUDE.md`.

---

## Arguments

- `[version]` — optional explicit milestone to plan (e.g. `1.3`). If omitted, resolve the
  next unstarted milestone automatically (Step 0).
- `--no-file` — skip the "offer to file gap issues" step (Step 9). The report is still
  written and the `Plan: <v>` issue is still created and updated (Step 2a).
- `--no-apply` — run the grooming pass (Step 6) and report the proposed commitment ledger,
  but write no labels to the tracker. The milestone description and Plan link (6e) are
  still written, with approval.

## How to ask the user

Every question in this skill goes through `AskUserQuestion`: at most four questions per
call, two to four options each, the recommended option first and labeled
`(Recommended)`, and every default naming the Step 1 input it came from. Never ask what
Step 1 already answered. A question the user declines is recorded as `assumed: <what you
proceeded on>` — an unanswered question that silently acquires an answer is how a release
acquires a promise nobody made.

---

## Step 0 — Resolve the target milestone

The target is the milestone **about to be built** — the next unstarted release, not
the one that just shipped. Never hardcode a version.

1. If `[version]` was given, use it.
2. Otherwise:
   - Read the **last shipped** version from the newest GitLab release, not a local tag —
     the local clone can be shallow:
     ```bash
     glab api "projects/:id/releases?per_page=5" | python3 -c "import json,sys; [print(r['tag_name'], r['released_at'][:10]) for r in json.load(sys.stdin)]"
     ```
     Skip pre-release tags (`-alpha`, `-beta`, `-rc`) when picking `$SHIPPED`.
   - List active milestones and pick the smallest numeric one strictly greater than the
     shipped version (ignore non-version milestones such as "Engineering health"):
     ```bash
     glab api "projects/:id/milestones?state=active&per_page=100"
     ```
3. Confirm before proceeding:
   > "Planning the **<VERSION>** milestone (last shipped: <SHIPPED>). Proceed?"

Export `$VERSION`, `$SHIPPED`, and `$MILESTONE_ID` (the **global** milestone `id`, not the
`iid` — milestone PUTs 404 on the iid). Every query, the report, and any filed issue must
reference `$VERSION` — never a hardcoded string.

Visiban is past 1.0, so the *Backward compatibility* rules in `CLAUDE.md` bind every
workstream: an open question that touches a REST field, an endpoint, a WebSocket event, a
migration, an env var, or an enterprise extension point is high-stakes by definition.

---

## Step 1 — Gather scope inputs (run in parallel)

Launch these as parallel sub-agents (`model: "sonnet"`) and wait for all. Brief each like
a new colleague (file paths, the exact question) per `CLAUDE.md` *Cost discipline*. Each
returns a structured summary, not raw dumps.

Every agent that pages the tracker uses this helper. `glab api --paginate` emits one JSON
array **per page, concatenated**, which a bare `json.load` rejects, and `per_page=100`
alone silently truncates at the first page:

```bash
read_pages() { python3 -c "
import json,sys
raw=sys.stdin.read(); dec=json.JSONDecoder(); i=0; out=[]
while i<len(raw):
    while i<len(raw) and raw[i].isspace(): i+=1
    if i>=len(raw): break
    o,i=dec.raw_decode(raw,i); out+=o
json.dump(out,sys.stdout)"; }
```

Count milestone contents with `issues?milestone=<title>&state=opened`, never
`milestones/:id/issues` — the latter ignores `state=`.

### 1a. Roadmap intent — the source of truth for *why*
> Read `$VERSION`'s intent from the milestone description (it carries a `Headline:` line)
> and any public roadmap copy for it on www.visiban.com (the `visiban-www` repo,
> `src/pages/`). The repo has no roadmap file of its own. Extract the themes
> attributed to `$VERSION` verbatim and classify each as planned or stretch. Everything in
> this plan stays **future-tense** in any doc reference — `$VERSION` has not shipped, and
> CI's `docs-version-accuracy` job (`scripts/check-docs-version-accuracy.sh`) rejects
> shipped-tense claims about an unreleased version.

### 1b. Tracked issues — what's already captured
> An issue titled `Plan: <v>` is the plan record (Step 2a), not a feature: exclude it from
> this set, the asset map and grooming.
>
> ```bash
> glab api --paginate "projects/:id/issues?milestone=$VERSION&state=opened&per_page=100" | read_pages > "$ISSUES"
> ```
>
> Return title, iid, labels (with the current `release::` value, or *unlabeled*), the
> `confidential` flag, and a one-line intent for each. **Read each issue's notes, not just
> its body** — an owner decision recorded in a comment can contradict the body, and a
> plan built on the body alone re-litigates it. Also run `git log origin/main --grep='#<iid>'`
> for each, and flag any issue whose work already merged.

### 1c. Deferred findings inherited from the last cycle
> Find work explicitly deferred *into* `$VERSION`: issues moved from `$SHIPPED`'s milestone
> during its close (including `security::deferred` items), `SUPPRESSED-UNTIL(#NNNN)`
> markers whose cited issue sits in `$VERSION`, and `TODO(#…)`, "deferred", or "next
> release" markers in code and `docs/`. Return the list so nothing silently drops.

### 1d. Personas — who each theme serves
> Read the *Personas* section of the root `CLAUDE.md` (Maya, Jordan, Sam, Alex —
> `.claude/personas.md` does not exist in this repo). Return each persona's primary goal
> and top pain point, so features can be sequenced by whose journey they unblock.

### 1e. Existing surface — what already exists to build on
> Survey what the milestone's themes will touch: `backend/` apps (models, viewsets,
> serializers, consumers), `frontend/src/` pages and components, WebSocket event types,
> and `docs/` pages. Return a short "already exists" inventory with file paths, so the
> asset map can distinguish *extend* from *build new*. Note anything whose OSS vs.
> enterprise classification is unclear (`docs/architecture/open-core-boundary.md`).

### 1f. Throughput of the previous cycle — the capacity baseline
> Count the issues closed in `$SHIPPED`'s milestone and the calendar weeks between the
> previous release and `$SHIPPED` (dates from the releases API), to get
> issues-closed-per-week. Split by kind (feature vs bug vs hardening) using labels where
> they support it. This is the only *measured* number in the kickoff questions; without it
> "how much fits" is a feeling.

### 1g. Carry-over — what is still open in the previous milestone
> List the issues still open in `$SHIPPED`'s milestone, if it is not closed. They do not
> silently become this milestone's problem: Step 2 asks whether they move. A
> `release::committed` label inherited from the previous milestone is a promise sized
> against a different capacity.

---

## Step 2 — Kickoff questions (ask before mapping or grooming)

These decide the **shape** of the release, and every later step depends on them: the asset
map needs the charter, sequencing needs the date-versus-scope rule, and the grooming pass
needs the capacity and the reserve. They are distinct from Step 5's questions, which are
per-feature design decisions.

**First create or reuse the Plan issue (Step 2a), then ask**, in **three
`AskUserQuestion` calls of four questions each**. The twelve questions are reference
material — read `.claude/skills/dotplanning/kickoff-questions.md` now and ask them as
written there.

Record every answer. They go verbatim into the report and feed Steps 5 and 6. After each
of the three calls, write the answers to the Plan record (Step 2a) before asking the next
call. When Step 2a found a draft, ask only from the first unanswered question; never
re-ask an answered one.

---

## Step 2a — The Plan record (`Plan: <v>` issue)

The plan's home is one tracker issue titled exactly `Plan: $VERSION`. Nothing is committed
to the repo, so planning needs no branch or MR. The state lives in the tracker, never a
local file, so any machine can resume.

**Create or reuse it before the first kickoff question**: after Step 1, before the three
Step 2 calls. Search titles only, all states:

```bash
glab issue list --search "Plan: $VERSION" --in title --all --per-page 100
```

Keep only results whose title is exactly `Plan: $VERSION` (a title search also matches
`Plan: 1.30`). Several open matches: stop and ask which stays. None open but a closed one
exists: ask before reopening. None: create it **without `--milestone`** — milestoning it
would put the planning record into the issue list Steps 1b and 6 read:

```bash
glab issue create --title "Plan: $VERSION" --description "$(cat <<'EOF'
<the body below>
EOF
)"
```

**The milestone link is written in Step 6e**, with the other milestone-description facts,
because that edit is outward-facing and approval-gated there.

**Body.** Prose first, then exactly one `visiban-plan` block at the end. *Kickoff answers*
lists all twelve questions from `kickoff-questions.md`, in that order and under those
names, each as the answer, `assumed: ...` for a declined one, or `(not yet asked)`:

````
## Plan: <VERSION>

Planned: <YYYY-MM-DD> · Status: draft · Updated: <YYYY-MM-DD>

### Kickoff answers
- Charter: <answer>
- Headliner count: <answer>
- Date or scope: <answer>
- Promised maturity: <alpha|beta|rc|GA>
- Capacity: <answer>
- Inbound reserve: <answer>
- Feature freeze: <answer>
- Hardening share: <answer>
- Carry-over: <answer>
- Credibility prerequisites: <answer>
- Unvalidated foundations: <answer>
- Cut line: <answer>

### Counts
(Omit this section until Step 6 produces the counts.)
Committed: <N> · Reserve: <N> · Stretch: <N>

### Workstreams, in order
1. <workstream> (gate chain: <chain>)

### Open 🔴 questions
- <question> (#<issue>)

```visiban-plan
schema: 1
version: <VERSION>
status: draft
planned: <YYYY-MM-DD>
committed: <N>
reserve: <N>
stretch: <N>
```
````

Until Step 6, **omit the count lines**; never post a literal `<N>` placeholder. Dates come
from `date +%Y-%m-%d`, never assumed. One answer per line: fold any newline in an answer to
`; `. Rewrite the whole body with `glab issue update <iid> --description "$(cat <<'EOF' ... EOF
)"`, never an append — the block must stay single.

**Resuming a draft.** When the reused open Plan issue has `status: draft`, read its body
(`glab issue view <iid> --output json | jq -r .description`) before asking anything. Find
the first *Kickoff answers* line still reading `(not yet asked)` and say what you found:
"Found a draft plan (Q1–Q8 answered on <Updated date>). Resume at Q9 (Carry-over)?" Offer
resume, start over, or stop. Never silently restart or overwrite a draft; start over only
on an explicit yes. All twelve answered but still `draft` means the run stopped after
Step 2 — say so and continue at Step 3. A body you cannot read in this shape (hand-edited,
missing lines): stop and show the user the issue instead of guessing.

**Re-run on a material scope change.** The issue may already be `ready`. Keep its sections
and kickoff answers, add a dated `### Revision <YYYY-MM-DD>` section above the block saying
what changed and why, and set `status: draft` until Step 10. `planned` keeps its original
date. Plan decisions made after kickoff go in dated comments on the same issue.

---

## Step 3 — Build the feature → asset map

The centerpiece. For each feature/theme in scope, assess every **asset class** it needs
and mark whether that asset exists, is planned (has an issue/design), or is missing (no
issue, no design, no decision).

| Asset class | What "ready" means |
|---|---|
| **Screen / UI** | The page or component exists, or has a `ux-design` proposal |
| **Flow / interaction** | The end-to-end path is designed: loading, empty, error, permission-denied, and keyboard path (Jordan) |
| **API / endpoint** | The endpoint exists or has an `architect` design; any change to an existing serializer is additive only |
| **Data model / migration** | Model and migration path defined: new columns nullable or `db_default`, indexes/constraints concurrent (`docs/development/database-migrations.md`), renames as add + copy + drop |
| **Real-time / WebSocket** | Every board-scoped write has a `board_*` event in the `{event, data}` shape, broadcast via `broadcast_board_event()` under `transaction.on_commit()`, and a frontend socket handler |
| **RBAC** | The minimum role per HTTP action is named, and object-level access (IDOR) is checked |
| **TypeScript contract** | The shared `Board` / `Card` / `User` interfaces change in the same MR as the serializer |
| **OSS / enterprise boundary** | Classified OSS or enterprise ("can a small team work without this?"); any enterprise half names the OSS extension point it registers against |
| **Background work** | Management commands and scheduled jobs the feature needs are identified |
| **Docs** | The `docs/features/` or `docs/administration/` page is planned, with a future-tense version callout |
| **Tests** | The layers are named: backend `pytest`, Vitest, Playwright e2e, and a concurrent test for any consume-once path |

Mark each cell:
- 🟢 **exists / ready** — build on what's there
- 🟡 **planned** — an issue or design covers it, but it isn't built
- 🔴 **missing** — no issue, no design, no decision; this gap will block the feature

Rank the 🔴 gaps, **screens and flows first** (they take longest and block everything
downstream), each with what's missing and the cheapest way to close it.

---

## Step 4 — Sequence the plan into gated workstreams

Turn the asset map into an **ordered** plan. Sequence by:

1. **Dependency** — models/endpoints before the screens that consume them; shared
   infrastructure before the features that build on it.
2. **Architecture / boundary risk** — features needing an `enterprise-check`,
   `threat-model`, or `architect` decision go first, because the outcome reshapes
   downstream work.
3. **Persona value** — within a tier, sequence by which persona's journey the work
   unblocks.

For each workstream, name the **gate chain it will trigger** — quote the matching row of
*Fast paths by change class* in the global `~/.claude/CLAUDE.md`, so the user sees the
real cost up front, and add `threat-model` where the workstream crosses a trust boundary
(auth path, authorization boundary, external data ingress, extension point, anonymous
read surface).

Do **not** run any of those gates here — `dotplanning` only *names* the chain each
workstream will need. Running them is the development that follows this plan.

---

## Step 5 — Open questions to answer before coding

List the decisions that must be settled before the affected workstream starts — the
high-cost, hard-to-reverse ones first. For each: phrase it as a decision, give the
realistic options, and give a recommendation. Prioritize questions that cross a trust
boundary, a public API / WebSocket / extension-point contract, or a data-migration path —
those are the expensive ones to get wrong. Record each decision once made in
`docs/architecture/decisions.md`.

---

## Step 6 — First grooming pass: propose a `release::` value for every issue

Skip any issue titled `Plan: <v>`.

Build the **commitment ledger**: one row per issue that will sit in `$VERSION` — the open
issues from 1b, the carry-over the user chose to move in (Q9), and the gap issues Step 9
will file. Each row carries the issue, its current label (or *unlabeled*), the
**proposed** label, and a one-line reason naming the rule that fired.

### 6a. Seed each proposal

Apply the first rule that matches:

| Rule | Proposed |
|---|---|
| Out of charter, not a prerequisite, and the user chose to defer it | **No label** — it moves to the next milestone |
| Implements a charter theme (Q1), or is a credibility prerequisite (Q10) | `release::committed` |
| Hardening inside the share the user set (Q8) | `release::committed` |
| A known bug a real user is likely to hit | `release::reserve` |
| Blocked by an unanswered Step 5 question with no answer date before its workstream starts | `release::stretch` — flagged "committed once #N is decided" |
| Its workstream ends after feature freeze (Q7) | `release::stretch` |
| Builds on an unvalidated foundation (Q11) | `release::stretch` unless the user says otherwise |
| Polish, hygiene, design exploration, unclaimed feature | `release::stretch` |

`release::reserve` is capacity held for reports from real users, not a "someday" bucket —
that is what `stretch` is for. A regression of a closed issue found during planning belongs
in the **current** working release, not a later one.

An issue that **already** carries a value keeps it unless a rule above contradicts it. Show
those as `current → proposed` and list the changes separately from the confirmations: a
kickoff pass that silently reshuffles a prior triage throws away a decision the user
already made. Any issue holding two `release::` values is proposed down to one.

### 6b. Fit the ledger to the answers

Check each and **report it as a number**:

- **Committed fit:** `count(committed) ≤ capacity (Q5) − reserve (Q6)`. If it does not fit,
  the plan is not finished. Present the overflow ranked lowest-persona-value first and ask
  whether to demote those issues or apply the Q3 rule and move the date. Never trim the
  committed set quietly to make the number work.
- **Reserve:** `count(reserve)` against the reserve number — slots already spent on known
  bugs, slots still free. Reserve over its number is the same problem as overflow.
- **Hardening share:** committed hardening ÷ committed, against Q8.
- **Roadmap reconciliation:** every roadmap bullet for `$VERSION` has at least one
  committed issue, and every committed feature issue maps to a bullet (hardening and
  prerequisites are exempt). **Only committed work is a roadmap bullet.** Report both
  directions; editing the roadmap is development, not this skill.

### 6c. Confirm with the user

The label is the user's call on every issue. At kickoff scale, confirmation is
**grouped**, not one question per issue:

1. Show the fit numbers from 6b first.
2. Present the ledger grouped by proposed value, with changes to existing labels as their
   own group, each with its count and the reasons that produced it. The row-by-row ledger
   goes in the report.
3. Ask per group: accept, or accept with the overrides the user names. A group the user
   reviewed and accepted is the user's decision; a label nobody reviewed is not.
4. Anything the user leaves undecided stays **unlabeled**, and the report lists it by
   number. An unlabeled issue in the milestone is a visible gap; a guessed label is an
   invisible one.

### 6d. Apply (skip if `--no-apply`)

Only after 6c. `glab issue update --label` *adds* a label without removing the current one,
so apply the confirmed value and drop the other two in the same command:

```bash
apply_release() {  # apply_release <iid> <committed|reserve|stretch>
  local keep="release::$2" drop=()
  for v in committed reserve stretch; do [ "$v" != "$2" ] && drop+=("release::$v"); done
  glab issue update "$1" --label "$keep" --unlabel "$(IFS=,; echo "${drop[*]}")"
}
```

Then read every issue back and assert **exactly one** `release::` value. The exit code is
not evidence that the old value dropped:

```bash
glab api --paginate "projects/:id/issues?milestone=$VERSION&state=opened&per_page=100" \
  | read_pages | python3 -c "
import json,sys
bad=[i['iid'] for i in json.load(sys.stdin) if not i['title'].startswith('Plan: ') and sum(l.startswith('release::') for l in i['labels'])!=1]
print('rows not holding exactly one release:: value:', bad or 'none')"
```

The issues the user left undecided will appear in that list — compare it against the 6c
undecided set. Anything else in it is a failed apply, not a decision.

Do not move carry-over or deferred issues between milestones unless the user asked for it
in Q9 or 6c — and anything moved **into** `$VERSION` goes through 6c like the rest.

### 6e. Milestone description and Plan link (always runs, also under `--no-apply`)

Outward-facing, so show the new description text and get a yes before writing. With
approval, add these lines to the milestone description, one fact per line. The first line
links the Plan record from Step 2a. **Preserve every other line already there** — Visiban's
milestone descriptions carry the `Headline:` and committed-scope prose:

```
Plan: #<iid>
Reserve: <N>
Feature freeze: <YYYY-MM-DD>
Maturity: <alpha|beta|rc|GA>
```

Read the current text first and write back the **whole** text with these lines added or
replaced:

```bash
glab api "projects/:id/milestones/$MILESTONE_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("description") or "")'
glab api --method PUT "projects/:id/milestones/$MILESTONE_ID" --raw-field "description=<full new text>"
```

If this is skipped, declined, or the run stops before it, the milestone does not link to
the Plan issue; Step 10 must say so.

---

## Step 7 — Delight wedge (one, optional)

Optionally propose **one** small, high-delight addition that would disproportionately win
over the milestone's primary persona — scoped to fit, not a new epic. If nothing fits the
cycle honestly, say "none in scope this cycle." Do not pad.

---

## Step 8 — Emit the HTML report

Produce a **self-contained** HTML file (inline CSS, no external assets) at:

```
$HOME/Downloads/dotplanning-<VERSION>-<YYYYMMDD>.html
```

Get the date with `date +%Y%m%d`. Write it with the `Write` tool. If `~/Downloads` is not
writable from this session, write it to the session scratchpad instead and give the user
the full path. The section list, severity palette, and CSS guidance are reference
material — read `.claude/skills/dotplanning/html-output-spec.md` now and follow it.

The report is a view of the same data as the Plan issue: the issue is the record and the
HTML is the copy for reading. If they differ, the issue wins.

After writing it, print the absolute path and a 6-line summary: milestone, # features
planned, # 🔴 missing assets, # open questions, committed/reserve/stretch counts against
capacity, and the delight wedge in one phrase.

---

## Step 9 — Offer to file gap issues (skip if `--no-file`)

For each 🔴 missing asset and each unresolved open question with no tracker issue, first
run the `duplicate-check` agent on the candidate, then offer to file it — **with
confirmation, one at a time**, showing the proposed `release::` value beside it:

```bash
glab issue create --title "<title>" --milestone "$VERSION" \
  --label "release::<value>" --description "$(cat <<'EOF'
## Gap identified by /dotplanning
<what's missing and why it blocks the milestone>

## Acceptance criteria
- [ ] <criterion>
EOF
)"
```

Never file without showing the list and getting a yes. A gap describing an unfixed security
weakness is filed `--confidential`, and its title and body must not appear in the public
HTML report beyond its issue number. If the user confirms the issue but not the label, file
it **unlabeled** and list it as an open commitment decision. Under `--no-apply`, file
unlabeled and propose the label in the message. Remember each filed issue's number beside
its question for Step 10.

---

## Step 10 — Finish the Plan record (always runs, also under `--no-file`)

1. Write the numbers of the issues Step 9 filed beside their questions in the Plan issue's
   *Open 🔴 questions* list, update the counts, and set `status: ready` in the block
   (rewrite the whole body). **Do not close the issue**: it stays open as the milestone's
   planning record until the release ships, so `/pre-release full` can be read against it.
   If 6d was skipped (`--no-apply`), label the counts `(proposed, not applied)` in the
   prose and say so.
2. Tell the user what was recorded and where: the Plan issue link and its `status`, the
   HTML report path, and any gap issues left unlabeled.
3. Warn explicitly whenever the milestone description does **not** link to the Plan issue,
   and whenever the plan was not recorded at all (`glab` unavailable) — `ready` is never
   claimed then.

---

## What dotplanning does NOT do

- It does not commit a plan file or open an MR: the record is the `Plan: <v>` issue.
- It never silently restarts or overwrites a draft Plan issue.
- It does not write feature code or run per-feature gates (`architect`, `ux-design`,
  `security-review`, …). It *names* which chain each workstream will trigger.
- It does not loop or re-audit after each fix — it is a one-time begin-gate. Mid-cycle
  triage is manual; re-running this skill mid-cycle rediscovers the same gaps.
- It does not invent scope. Everything traces to the roadmap, a tracked issue, an
  inherited deferred finding, or a persona need — the appendix proves it.
- It does not decide a commitment value on the user's behalf. Step 6 proposes and the user
  confirms; a group nobody reviewed is left unlabeled and reported as such.

## Anti-patterns to refuse

- Planning a version that wasn't confirmed in Step 0.
- Past/present-tense claims about `$VERSION` in any doc-facing text.
- A feature→asset map with no 🔴 cells — that means the audit was too shallow, not that
  nothing is missing. Look harder at screens, flows, WebSocket events, and docs.
- Filing gap issues without confirmation, or filing duplicates of existing issues.
- Proceeding to the asset map before the Step 2 answers exist. Inventing a capacity to get
  moving is how the milestone acquires a number nobody agreed to.
- Applying a label from 6a's proposal without the 6c confirmation, or trimming the
  committed set quietly so the 6b numbers come out right.
