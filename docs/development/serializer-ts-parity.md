# Two CI checks keep TypeScript interfaces in step with serializers

Add a serializer field and the matching TypeScript interface field in the same MR, or CI fails.

**Why it matters:** The checks cover different things, and a green run of one says nothing about the other. Two CI checks enforce the parity rule `CLAUDE.md` states plainly:

> `Board`, `Card`, `User`, and related interfaces must match the backend serializer fields exactly — when a new serializer field is added, update the corresponding TypeScript interface in the same MR.

**Watch out:** Read this section before assuming either one covers your change.

| Check | Source of truth | Covers | Checks |
|---|---|---|---|
| `backend/boards/tests/test_ts_serializer_drift.py` (#821, since 1.1) | The serializer classes (`instance.fields`) | **15** pairs, incl. `BoardFull`, `CardActivity`, `CardAttachment` | Field **names**, both directions |
| `serializer-ts-parity` CI job (#1079 + #1139 + #1209 + #1282 + #1294 + #1296 + #1338, this page) | The **generated OpenAPI document** (generated with `GIT_LENS_ENABLED=True`, #1338) | **49** pairs — every pair that has a schema component | Names, **types**, nullability, enum membership, **array item types** |

Neither supersedes the other, and a green run of one says nothing about the other. Through
#1139 the coverage gap was a structural one — #821 reached two pairs this gate could not,
because `drf-spectacular` emitted no component for them (a third, `BoardFull`, gained a
component in #1137). #1209 wired real response schemas for the endpoints behind `CardActivity`,
`CardAttachment`, and two more pairs #821 doesn't reach at all (`Notification`, `PublicCard`),
closing that gap. See [Coverage](#coverage) for the pair-by-pair table.

Until #1139, this gate type-checked only five pairs while #821 name-checked fourteen, so a
green job read as much broader assurance than it delivered. Widening it to eighteen turned up
nine more real mismatches on the new pairs (and one false positive caused by a defect in the
gate's own TypeScript alias parser).

**The distinction that matters:** #821 asks "does the serializer emit this field?" This gate asks "does the document we publish describe it correctly?" A field can pass the first and fail the second, and in practice several do:

- Eight fields on `Board` and `CurrentUser` were published as `string` while returning ints, bools and nested objects (#1135).
- `BoardFull.members` sent rows the `BoardMembership` component forbids (#1137, fixed by publishing `BoardFull` with its own `EffectiveBoardMember` row component).
- A nullable field was declared non-nullable (#1138, fixed). A declared serializer field doesn't inherit `null=True` from the model the way an auto-generated one does. `Board.group_name` had the same symptom but was already fixed by earlier, unrelated work before #1138's branch existed.

Every one of those passes #821's name check, because the serializer does emit the field. The *published type* is wrong, and the published type is what an external consumer generates a client from.

## Why this gate exists

Three views of the API exist:

- the frontend's, in `frontend/src/types/index.ts` as hand-written interfaces;
- the backend's, in DRF serializers;
- the outside world's, in the generated OpenAPI document.

All three are internally consistent, and until this gate nothing compared the third against the first. Drift was silent in both directions:

| Drift | What you see |
|---|---|
| Serializer gains a field, TypeScript doesn't | Nothing. The data arrives and the SPA can't see it. No error anywhere. |
| A field's *type* changes on one side only | Nothing, until a component renders a number as a string, or reads `.length` off a boolean. |
| A serializer stops sending a field | `tsc` catches it only if some component happens to read that property. |

That is the failure shape that motivated the gate: two representations of one contract, each internally consistent, with no third thing checking that they agree.

## What it checks

The job regenerates the OpenAPI schema with `drf-spectacular` and compares its components against the hand-written interfaces. It runs the same command as `backend-schema-validate`, and for the same reason it needs no database.

Seven kinds of mismatch are reported:

| Check | Fires when |
|---|---|
| `missing_in_ts` | A serializer sends a field no interface declares |
| `missing_in_schema` | An interface declares a field no serializer sends |
| `type_family` | Both declare a type and the families disagree (string / number / boolean / array / object) |
| `untyped_schema` | The schema declares no resolvable type at all — a `JSONField` or bare `Field` reaching the client as `unknown` |
| `nullability` | One side admits `null` and the other doesn't |
| `enum_members` | Both resolve to a set of string values and the sets differ |
| `array_item_type` | Both sides are arrays, the schema's `items` is a `$ref` to a component `COMPONENT_MAP` itself maps, and the TypeScript element type names a *different* mapped interface (#1296) |

A check is **skipped, never guessed**, when either side can't be classified confidently. An unresolvable TypeScript alias produces no finding rather than a false one. Optional fields (`x?: T`) are exempt from the nullability check, because in this codebase `?` already carries the "only present under some conditions" meaning (an `?expand=` payload, for instance).

`array_item_type` is deliberately narrow, not a general structural recursion into array elements. Every check above reduced an array field to the single family `array` on both sides and stopped, which missed real drift. `BoardPublic.swimlanes` was typed `Swimlane[]` while the serializer's `items` schema was a `$ref` to `PublicSwimlane`, a narrower shape (#1140) that deliberately drops `custom_field_values`, `contact_email`, and `notes`. Every array-typed field on all 44 pairs mapped before #1296 had this blind spot. The check only fires when *both* sides name something comparable:

- The schema's `items` must resolve to a direct `$ref` (optionally through one level of `allOf`
  wrapping — the same shape `_unwrap_schema` already follows for a plain field). An inline item
  schema or a primitive item has no name to compare and is left to the outer `array`-vs-`array`
  check.
- That `$ref`'s component name must itself be a `COMPONENT_MAP` key — the same map the whole
  gate is keyed on, so there's no second table for "what should this item be". If the item's
  component is **not** mapped, the check is silently skipped, the same "skip, don't guess" rule
  every other check here follows — see [What is not covered, and why](#what-is-not-covered-and-why)
  for what that specific gap means in practice.
- On the TypeScript side, only a bare capitalised identifier before `[]` (or inside
  `Array<...>`) counts as a named element type; an inline object literal or a primitive element
  is skipped the same way an unmapped schema item is.

## Coverage

`COMPONENT_MAP` in the script is authoritative. As of #1338 it's:

> `CurrentUser` -> `User`: its instance-level flags are frozen (#1664); new ones go on `SiteConfig`. See [Frozen instance flags](../api/authentication.md#frozen-instance-flags-on-authuser).

| Schema component | TypeScript interface | Also name-checked by #821 |
|---|---|---|
| `Board` | `Board` | yes |
| `AdminBoardInviteLink` | `AdminBoardInviteLink` | yes |
| `AdminUser` | `AdminUser` | no |
| `BoardExportLog` | `BoardExportLogEntry` | no |
| `BoardFull` | `BoardFull` | yes |
| `BoardInviteLink` | `BoardInviteLink` | yes |
| `BoardInviteLinkCreateResponse` | `CreatedBoardInviteLink` | no |
| `BoardMembership` | `BoardMembership` | yes |
| `BoardTemplate` | `BoardTemplate` | no |
| `BoardUser` | `BoardUser` | yes |
| `Card` | `Card` | yes |
| `CardActivity` | `CardActivity` | yes |
| `CardAttachment` | `CardAttachment` | yes |
| `CardChecklist` | `CardChecklistItem` | yes |
| `CardComment` | `CardComment` | yes |
| `CardMovement` | `CardMovement` | yes |
| `CardRelation` | `CardRelation` | no |
| `CardTimelineEntry` | `CardTimelineEntry` | no |
| `Column` | `Column` | yes |
| `CurrentUser` | `User` | no |
| `CustomFieldDefinition` | `CustomFieldDefinition` | no |
| `CustomFieldValue` | `CustomFieldValue` | no |
| `EffectiveBoardMember` | `EffectiveBoardMember` | no |
| `ExternalRef` | `CardExternalRef` | yes |
| `Group` | `Group` | no |
| `GroupBrief` | `GroupBrief` | no |
| `GroupInviteLink` | `GroupInviteLink` | no |
| `GroupLabel` | `GroupLabel` | no |
| `GroupMembership` | `GroupMembership` | no |
| `InviteLink` | `AdminInviteLink` | no |
| `InviteLinkCreateResponse` | `CreatedAdminInviteLink` | no |
| `Label` | `Label` | yes |
| `LensConnection` | `LensConnection` | no |
| `LinkedCard` | `RelatedCardRef` | no |
| `Notification` | `Notification` | no |
| `OwnedBoardSummary` | `OwnedBoardSummary` | no |
| `PersonalAccessToken` | `PersonalAccessToken` | no |
| `PersonalAccessTokenCreateResponse` | `CreatedPersonalAccessToken` | no |
| `PublicAssignee` | `PublicAssignee` | no |
| `PublicBoard` | `BoardPublic` | no |
| `PublicCard` | `PublicCard` | no |
| `PublicSwimlane` | `PublicSwimlane` | no |
| `SavedFilter` | `SavedFilter` | no |
| `ShareBoardResponse` | `ShareActionResponse` | no |
| `SiteConfig` | `SiteConfig` | no |
| `SiteEmailSettingsResponse` | `SiteEmailSettings` | no |
| `SiteSetting` | `SiteSettings` | no |
| `Swimlane` | `Swimlane` | yes |
| `SwimlaneCustomFieldDefinition` | `SwimlaneCustomFieldDefinition` | yes |

**The mapping isn't keyed on the two names matching.**

- There's no `User` component: the `/api/v1/auth/me/` shape is `CurrentUser`.
- `CardChecklist` is the component behind the `CardChecklistItem` interface.
- Both are one resource under two spellings, and leaving either out would be a hole the gate's own name check can't see.
- `ExternalRef`/`CardExternalRef` is the same shape again. `ExternalRefSerializer` is a plain `serializers.Serializer` nested on `Card.external_ref` rather than a top-level `ModelSerializer`, which is why it was missed when the map was built and stayed missing, undetected, until #1282 added it. Diffing the two found no drift.

#1282's completeness-check widened the audit past #821's own name-checked list (which only sees `ModelSerializer`/`Serializer` subclasses it imports directly). It found four more components with a real, hand-maintained TypeScript interface on the other end that had simply never been added to the map:

- `PublicAssignee` (`PublicAssigneeSerializer`, the display-name-only user on a public
  share-link card) — identical name on both sides, the same miss as `ExternalRef` above, just
  without a rename to make it visible.
- `LinkedCard` (`LinkedCardSerializer`, the compact card reference on a `CardRelation`, #449) →
  `RelatedCardRef` — a renamed pair, same shape as `CardChecklist`/`CardChecklistItem`.
- `BoardExportLog` (`BoardExportLogSerializer`, the export-history audit row, #842/#980) →
  `BoardExportLogEntry` — another renamed pair.
- `ShareBoardResponse` (an `inline_serializer` in `boards/views/boards.py`, backing
  `POST /api/v1/boards/{id}/share/`) → `ShareActionResponse`, the interface
  `enableBoardSharing()` imports in `frontend/src/api/boards.ts`. Its sibling
  `UnshareBoardResponse` stays unmapped — see [What is not covered](#what-is-not-covered-and-why).

All four diffed clean — no real drift found on any of them.

A later pass of this same audit found a fifth, different-shaped miss.

- **`PublicBoard`** (`PublicBoardSerializer`, the outer `{uid, name, columns, swimlanes, labels, cards}` shape at `GET /api/share/{token}/`) had been *documented* as having no TypeScript interface, in "What is not covered, and why" below. But `BoardPublic` in `frontend/src/types/index.ts` is exactly that shape under a renamed name, the same pattern as `CurrentUser`/`User`. That was a documentation error, not a structural gap, and #1282 fixed the record and mapped the pair.
- **`BoardPublic.swimlanes`** was typed `Swimlane[]` rather than a dedicated `PublicSwimlane[]` at the time. This gate's array check then compared only the outer `array` family and didn't recurse into item shapes, so that looseness produced no finding and needed no suppression.
- **#1296** closed the gap on both sides. It added an `array_item_type` check (see [What it checks](#what-it-checks)) that follows a schema array's `items` `$ref` and compares it against the TypeScript element type. It gave the public swimlane shape its own `PublicSwimlane` interface (matching `PublicSwimlaneSerializer` exactly; see [What is not covered, and why](#what-is-not-covered-and-why) for why that pair was excluded before), so `BoardPublic.swimlanes` could be correctly typed `PublicSwimlane[]` and the new check had something correct to compare it against. `PublicSwimlane` is now mapped in [Coverage](#coverage) above.

#1294 closed the structural gap the reverse sweep found (see [What is not covered, and why](#what-is-not-covered-and-why) below). Twelve of the thirteen pairs listed there had no schema component only because nothing in their view ever called `@extend_schema` or set `serializer_class`. Adding that annotation, never a runtime, queryset, or permission change, gave each one a real component, now mapped above:
`AdminUser`, `BoardTemplate`, `CardTimelineEntry`, `GroupInviteLink`, `GroupMembership`,
`InviteLink`/`InviteLinkCreateResponse` (→ `AdminInviteLink`/`CreatedAdminInviteLink`),
`OwnedBoardSummary`, `PersonalAccessToken`/`PersonalAccessTokenCreateResponse` (→
`PersonalAccessToken`/`CreatedPersonalAccessToken`), `SavedFilter`, `SiteConfig`, and
`SiteEmailSettingsResponse`/`SiteSetting` (→ `SiteEmailSettings`/`SiteSettings`). Mapping them
surfaced findings of every kind this gate exists to catch, all fixed at the schema-annotation
level with no behavior change:

- **A parser gap, not drift.** `CreatedAdminInviteLink extends AdminInviteLink` and
  `CreatedPersonalAccessToken extends PersonalAccessToken` are the only two TypeScript
  interfaces in the codebase that use `extends`, and `parse_ts_interfaces()` was dropping the
  base interface's fields entirely — reporting nine and eight `missing_in_ts` findings that were
  not real drift, just a parser that had never needed to resolve inheritance before. Fixed by
  merging a derived interface's inherited fields into its own during parsing.
- **`untyped_schema`** on three plain `JSONField`/`DictField`-backed properties that had never
  been checked before: `BoardTemplate.columns_json`, `PersonalAccessToken.scopes`, and
  `SavedFilter.state_json`. All three are read-only in every path that reaches these serializers
  today, so each was given an explicit `ListField`/`DictField` declaration matching its real
  shape — documentation only, not a validation change.
- **`nullability`** on `InviteLink.created_by_username` (an undecorated `SerializerMethodField`
  gained a `-> str | None` return annotation) and `GroupInviteLink.created_by_username` (a
  declared `CharField` with a traversing `source` over a nullable FK gained `allow_null=True`) —
  the same two patterns #1139 already documented under
  [When the gate fails](#when-the-gate-fails), just not previously reachable because neither
  pair had a component to check. `GroupMembership.id` got the same treatment: the `members`
  action sets `id=None` on inherited rows with no real membership behind them, which the
  auto-generated (non-nullable) PK field couldn't describe, so `id` is now declared explicitly
  with `allow_null=True`.
- A genuine **TypeScript-only field**: `GroupInviteLink.token` is appended to
  `GroupInviteLinkSerializer(...).data` by hand, once, only on the creation response — the same
  shape as `AdminInviteLink`/`CreatedAdminInviteLink`, but without a second interface, so
  `GroupInviteLink.token` is optional and now listed in `TS_ONLY_FIELDS` rather than treated as
  drift.

The thirteenth, `LensConnection`, was excluded for a structural reason (its app exists only with
`GIT_LENS_ENABLED`) until #1338 generated the parity schema with the flag on and mapped it; see
[What is not covered, and why](#what-is-not-covered-and-why).

### What is not covered, and why

Until #1209, two pairs #821 name-checks were absent here for a structural reason: the schema
had no component to diff against, so there was nothing this gate could compare. `CardActivity`
and `CardAttachment` backed endpoints (`CardViewSet.activities`/`.attachments`) that fell back
to the viewset's default `CardSerializer` with no dedicated response wiring, so
`drf-spectacular` published the wrong component entirely rather than none. #1209 gave both
endpoints real `@extend_schema` response annotations, so both are now mapped and checked (see
[Coverage](#coverage)). The same issue also wired `NotificationListView` and `ShareBoardView`
for the first time, adding `Notification` and `PublicCard` to the map.

More pairs remained absent for that same structural reason than #1282's first pass found. That
pass swept `COMPONENT_MAP` forward — every key in it against the generated schema — which by
construction can't see an interface whose serializer never reaches the schema at all. The
correct sweep runs the other direction: every `export interface` in
`frontend/src/types/index.ts`, checked against `COMPONENT_MAP`'s values and the "opposite
reason" table below. That reverse sweep turned up sixteen TypeScript interfaces across thirteen
pairs, each backed by a real serializer (or, for `SiteConfig`, a view that built its response by
hand) that `drf-spectacular` published no component for — because nothing in their view called
`@extend_schema` or set `serializer_class`, the two things spectacular introspects. An
interface with **no** backing serializer at all — `FieldDefinitionShape` (a structural subtype
satisfied by two already-mapped interfaces, not its own shape), `SwimlaneCustomFieldValue`
(carried inside `Swimlane.custom_field_values`, not its own component — see `_DRIFT_PAIRS`'
comment in `test_ts_serializer_drift.py`), and the `Lens*` / `TrelloImport*` interfaces (plain
dataclasses serialized by hand, not DRF serializers) wasn't this bug class and was never listed
here.

**#1294 closed twelve of those thirteen pairs** by adding the missing `@extend_schema`
annotation (or, for `SiteConfig` and the two `Created*` creation responses, an `inline_serializer`
/ subclass documenting the hand-built response) to each view — annotation only, no runtime,
queryset, or permission change. All twelve are now mapped; see
[Coverage](#coverage) and the note above it for the drift each one surfaced and how it was fixed.

The thirteenth, `LensConnection` (`LensConnectionSerializer`, `backend/git_lens/`), was excluded
until #1338 for a structural reason: the `git_lens` app and all of its URLs exist only when
`GIT_LENS_ENABLED=true`, and the parity job ran with the flag off, so its schema had no
`LensConnection` component to diff. `generate_schema()` in the script now forces
`GIT_LENS_ENABLED=True` for schema generation (and the job sets it too), so the component is
always present and the pair is mapped. The flag is set only for this job's schema generation;
`backend-schema-validate` and `backend-schema-fuzz` still run flag-off, and the lens routes are
fuzzed by their own job, `backend-schema-fuzz-git-lens` (see [OpenAPI](../api/openapi.md)).
Diffing the pair found no drift: the `created_by` nullability fixed in #1331 is the kind of
mismatch it would have caught, and does catch if the TypeScript side regresses.

Two pairs are absent for the opposite reason — the schema has a component but there's no
TypeScript interface to diff it against. Confirmed by grepping all of `frontend/src` (not just
`types/index.ts` — the `api/*.ts` call sites are where a renamed interface would be
consumed) for each of these two; neither turned up a renamed or differently-named interface the
way `PublicBoard`/`BoardPublic` turned out to be one:

| Pair | Why excluded |
|---|---|
| `CardQuery` (`CardQuerySerializer`, `GET /api/v1/cards/`, #1112) | No TypeScript interface exists — `frontend/src/api/cards.ts` has no caller of this endpoint yet. Mapping it to the closest interface, `Card`, wouldn't work: `CardQuery` sends every `Card` field plus `board` by design (a cross-board list must say which board each row is on), so the pair would report a permanent `missing_in_ts: board` finding that isn't real drift. Revisit once a frontend consumer exists and needs its own interface (#1172). |
| `UnshareBoardResponse` (an `inline_serializer` in `boards/views/boards.py`, backing `DELETE /api/v1/boards/{id}/share/`) | No TypeScript interface exists — `disableBoardSharing()` in `frontend/src/api/boards.ts` calls `client.delete(...)` with no generic type argument at all, so it never reads a typed response body. Structurally identical to `ShareBoardResponse` (mapped above, to `ShareActionResponse`), but with no TypeScript consumer to diff it against. |

`PublicSwimlane` (`PublicSwimlaneSerializer`, nested on `PublicBoardSerializer.swimlanes`,
`GET /api/share/{token}/`) was in this table until #1296. It used to have the same shape as
`CardQuery` above — no dedicated TypeScript interface, with `BoardPublic.swimlanes` reusing the
wider `Swimlane[]` instead — but #1296's `array_item_type` check (see
[What it checks](#what-it-checks)) needed a correct, dedicated interface to compare the array's
element type against, so the frontend now declares `PublicSwimlane` matching
`PublicSwimlaneSerializer` exactly (`id`, `uid`, `name`, `position`, `color`, `is_collapsed`,
`created_at` — no `custom_field_values`, `contact_email`, or `notes`), and the pair is mapped in
[Coverage](#coverage).

`PublicBoard` was removed from this table by #1282: it does have a TypeScript interface —
`BoardPublic` — and is now mapped in [Coverage](#coverage) instead. The entry above was wrong
from the day it was written, not something that went stale later; see the note under
[Coverage](#coverage) for the correction.

Everything else is deliberately in scope and mapped. Of the pairs that have **both** a schema
component and a hand-maintained TypeScript interface, none is left unchecked.

## Running it locally

```bash
# Full check: regenerates the schema, then diffs (needs the backend venv)
python3 scripts/check-serializer-ts-parity.py

# Reuse a schema you already generated
python3 scripts/check-serializer-ts-parity.py --schema openapi.json

# Point at a different interfaces file (defaults to frontend/src/types/index.ts)
python3 scripts/check-serializer-ts-parity.py --types path/to/index.ts

# Show every mismatch, including tracked ones
python3 scripts/check-serializer-ts-parity.py --no-suppressions

# Prove the gate itself still works
python3 scripts/check-serializer-ts-parity.py --self-test
```

Exit codes: `0` parity holds, `1` drift or a stale suppression, `2` usage or environment error.
`2` is kept distinct from `1` so a gate that couldn't run is never mistaken for a clean tree.

## When the gate fails

Read which direction it drifted, then fix the side that's wrong — **not** whichever is
quicker to edit.

- **`missing_in_ts`** — you added a serializer field. Add it to the interface in the same MR.
- **`missing_in_schema`** — usually a serializer field that was removed. Confirm it's
  genuinely gone (removing a response field is a backward-compatibility violation on its own,
  see `CLAUDE.md`), then remove it from the interface.
- **`type_family` / `untyped_schema`** — most often the *schema* is wrong, not the frontend. An
  undecorated `SerializerMethodField` has no inferable return type, so `drf-spectacular`
  describes it as `string`; a `JSONField` gets no type at all. Fix it at the serializer:

```python
# A return annotation is enough for a method field
def get_member_count(self, obj) -> int:
    return obj.memberships.count()

# A nested object or an array needs the shape spelled out
@extend_schema_field(GroupBriefSerializer(allow_null=True))
def get_group_detail(self, obj):
    ...
```

- **`nullability`** — a declared serializer field (a nested serializer, or a `CharField` with a
  traversing `source`) doesn't inherit `null=True` from the model the way an auto-generated
  `ModelSerializer` field does. Add `allow_null=True`. On a `read_only` field this is
  schema-only.
- **`enum_members`** — the choice sets diverged. Decide which is authoritative before editing.

**Watch out:** #1139 hit both directions of `nullability` in one branch, and they have opposite fixes:

- The **schema** understates it. A declared field (nested serializer, or a `CharField` with a
  traversing `source`) over a model FK with `null=True` publishes as non-nullable while the
  response has always been able to carry `null`. Add `allow_null=True`. On a `read_only` field
  that's a documentation fix, not a contract change.
- The **TypeScript** overstates it. A `CharField` with `null=False, blank=True, default=""`
  returns `""` and never `null`, so a `string | null` interface describes a payload the API
  can't produce. Narrow the interface — and check the test fixtures, which tend to encode the
  impossible shape too.

Read the model field before choosing. The two cases look identical in the gate's output, and the wrong fix in either direction is a lie in the opposite place.

## Suppressions

Real, already-tracked drift is recorded in the `SUPPRESSIONS` table in
`scripts/check-serializer-ts-parity.py`, spelled `SUPPRESSED-UNTIL(#N)` to match the
convention in [suppression markers](https://gitlab.com/visiban/visiban/-/issues/1092).

These suppressions are **self-invalidating**, which is the part that matters. Each records the exact mismatch it masks, the schema type and the TypeScript type as they are today:

```python
Suppression(TYPE_FAMILY, "Board", "member_count",
            schema_repr="string", ts_repr="number", issue=1135,
            reason="SerializerMethodField returns int, described as string"),
```

When reality stops matching that record because the cited issue's fix landed, the suppression has done its job, and the gate **fails** asking for its removal. A suppression therefore can't outlive its reason, which is the usual way a suppression quietly turns a gate green forever.

This is deliberately not an issue-state lookup. Tying staleness to the observed drift needs no network and no GitLab token, so it works offline and in a fork's pipeline.

Adding one:

- It must cite a **specific, already-filed** issue. Never a placeholder, never a number invented
  on the spot. If the drift has no tracking issue, file one first.
- Record the mismatch exactly as the gate reports it — run with `--no-suppressions` to see it.
- Don't add one for drift you could fix. A suppression is for a mismatch whose fix is
  out of scope for the branch in front of you, not for one that's merely inconvenient.

## TypeScript-only optional fields

These aren't interchangeable with a suppression. Sometimes a single interface stands in for several serializers of one resource:

- `Swimlane` unions `SwimlaneSerializer` and `SwimlaneAdminSerializer` — `contact_email` and
  `notes` are withheld from viewer-role members as PII, and only the public serializer reaches
  the schema.
- `Group` unions the list and retrieve serializers — `ancestors` is on `GroupDetailSerializer`
  only, deliberately omitted from the list one to avoid an N+1 ancestor walk per row.

`?` is how the codebase spells "present only on some of them", so these fields produce a
`missing_in_schema` finding that isn't drift. They are listed in `TS_ONLY_FIELDS` in the script
with their reason. #821's test records the identical fact in its `extra_allowed_fields_on_ts`
column, so this mirrors a reviewed convention rather than inventing a second one.

These entries cite **no issue**, because nothing is broken and there's nothing to fix. Three
properties keep the table from degenerating into an allowlist:

- **Per pair and per field.** Nothing is waived wholesale; `missing_in_schema` stays fully live
  for every other field on the pair.
- **Conditional on the field still being optional.** Drop the `?` and the finding comes back — a
  *required* interface field the API never sends is a real defect.
- **Self-invalidating**, exactly like a suppression. If the component gains the property, the
  entry matches nothing and the gate fails asking for its removal.

If the mismatch is real drift rather than a serializer split, it needs a suppression and an
issue — not an entry here.

## Self-test

Per the house rule in [#1093](https://gitlab.com/visiban/visiban/-/issues/1093), this gate
ships a `--self-test` mode, and CI runs it **immediately before** the real invocation on the
same image. A gate that has stopped detecting anything looks exactly like a clean codebase; the
self-test builds a synthetic schema and interface carrying one instance of every finding kind,
asserts each is caught, and asserts that a matching pair stays silent and that the suppression
and TypeScript-only machinery both apply and go stale. It needs no network and no database.

`scripts/tests/check-serializer-ts-parity.test.sh` covers the command-line surface CI depends on
— exit codes and fail-safe behavior on a missing or malformed input. Its fixtures read
`COMPONENT_MAP` out of the gate rather than hard-coding the pair list, so adding a pair doesn't
silently invalidate them.

## What is out of scope

**WebSocket event payloads.** The `{event, data}` contract in
`frontend/src/hooks/useBoardSocket.ts` isn't schema-derived and isn't checked here. The
schema *does* contain a `BoardEvent` component, but it describes the REST event-feed
serializer — a different shape that merely shares a name. Mapping the WebSocket union onto it
would assert a correspondence that doesn't exist. That union stays hand-maintained;
[#1078](https://gitlab.com/visiban/visiban/-/issues/1078) covers WebSocket event reachability
separately.

**Pairs with a component but no TypeScript interface.** `CardQuery` and `UnshareBoardResponse`
— see [What is not covered, and why](#what-is-not-covered-and-why). (`PublicSwimlane` was in
this category until #1296 gave it a dedicated interface.)

**Request bodies.** `SPECTACULAR_SETTINGS` sets `COMPONENT_SPLIT_REQUEST: True`, so the schema
carries 34 separate `*Request` / `Patched*Request` components describing what you may *send*.
This gate compares **response** components only. A write-only field whose type drifts triggers
the job (it's still a `backend/**/*` change) but produces no finding. If the frontend grows
explicit request-body interfaces, mapping them is the natural extension.

**Nothing else, with one standing exception.** Every schema component that has a matching
TypeScript interface *and reaches the schema this gate's own environment generates* is mapped as
of [#1294](https://gitlab.com/visiban/visiban/-/issues/1294), so a green `serializer-ts-parity`
run means "the published response components and the interfaces agree", not "forty-five of them do".
`LensConnection`, the one component this job used to be unable to see (its app is feature-flagged),
is mapped since #1338: the job generates its schema with `GIT_LENS_ENABLED=True`. A component
from another flag-gated app would need the same treatment. If you add a serializer *and* an
interface, add the pair to `COMPONENT_MAP` in the same MR — the gate doesn't discover pairs on
its own, and an unmapped pair is unchecked silently.
