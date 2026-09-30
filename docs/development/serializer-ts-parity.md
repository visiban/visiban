# Serializer ↔ TypeScript parity

Two CI checks enforce the parity rule `CLAUDE.md` states plainly:

> `Board`, `Card`, `User`, and related interfaces must match the backend serializer fields exactly — when a new serializer field is added, update the corresponding TypeScript interface in the same MR.

They cover different things. **Read this section before assuming either one covers your
change.**

| Check | Source of truth | Covers | Checks |
|---|---|---|---|
| `backend/boards/tests/test_ts_serializer_drift.py` (#821, since 1.1) | The serializer classes (`instance.fields`) | **15** pairs, incl. `BoardFull`, `CardActivity`, `CardAttachment` | Field **names**, both directions |
| `serializer-ts-parity` CI job (#1079 + #1139 + #1209 + #1282 + #1294 + #1296, this page) | The **generated OpenAPI document** | **45** pairs — every pair that has a schema component | Names, **types**, nullability, enum membership, **array item types** |

Neither supersedes the other, and a green run of one says nothing about the other. Through
#1139 the coverage gap was a structural one — #821 reached two pairs this gate could not,
because `drf-spectacular` emitted no component for them (a third, `BoardFull`, gained a
component in #1137). #1209 wired real response schemas for the endpoints behind `CardActivity`,
`CardAttachment`, and two more pairs #821 does not reach at all (`Notification`, `PublicCard`),
closing that gap. See [Coverage](#coverage) for the pair-by-pair table.

Until #1139, this gate type-checked only five pairs while #821 name-checked fourteen, so a
green job read as much broader assurance than it delivered. Widening it to eighteen turned up
nine more real mismatches on the new pairs (and one false positive caused by a defect in the
gate's own TypeScript alias parser).

The distinction that matters: #821 asks "does the serializer emit this field?" — this gate
asks "does the document we publish describe it correctly?" A field can pass the first and fail
the second, and in practice several do. Eight fields on `Board` and `CurrentUser` were
published as `string` while returning ints, bools and nested objects (#1135); `BoardFull.members`
sent rows the `BoardMembership` component forbids (#1137, fixed by publishing `BoardFull` with
its own `EffectiveBoardMember` row component); a nullable field was declared
non-nullable (#1138, fixed — a declared serializer field does not inherit `null=True` from the
model the way an auto-generated one does; `Board.group_name` had the same symptom but was
already fixed by earlier, unrelated work before #1138's branch existed). Every one of those
passes #821's name check, because
the serializer really does emit the field — it is the *published type* that is wrong, and the
published type is what an external consumer generates a client from.

## Why this gate exists

The frontend's view of the API lives in `frontend/src/types/index.ts` as hand-written
interfaces. The backend's lives in DRF serializers, and what the outside world sees lives in
the generated OpenAPI document. All three are internally consistent, and until this gate
nothing compared the third against the first. Drift was silent in both directions:

| Drift | What you see |
|---|---|
| Serializer gains a field, TypeScript does not | Nothing. The data arrives and the SPA cannot see it. No error anywhere. |
| A field's *type* changes on one side only | Nothing, until a component renders a number as a string, or reads `.length` off a boolean. |
| A serializer stops sending a field | `tsc` catches it only if some component happens to read that property. |

This is the failure shape that motivated the gate: two representations of one contract, each
internally consistent, with no third thing checking that they agree.

## What it checks

The job regenerates the OpenAPI schema with `drf-spectacular` — the same command
`backend-schema-validate` runs, and for the same reason it needs no database — and compares
its components against the hand-written interfaces.

Seven kinds of mismatch are reported:

| Check | Fires when |
|---|---|
| `missing_in_ts` | A serializer sends a field no interface declares |
| `missing_in_schema` | An interface declares a field no serializer sends |
| `type_family` | Both declare a type and the families disagree (string / number / boolean / array / object) |
| `untyped_schema` | The schema declares no resolvable type at all — a `JSONField` or bare `Field` reaching the client as `unknown` |
| `nullability` | One side admits `null` and the other does not |
| `enum_members` | Both resolve to a set of string values and the sets differ |
| `array_item_type` | Both sides are arrays, the schema's `items` is a `$ref` to a component `COMPONENT_MAP` itself maps, and the TypeScript element type names a *different* mapped interface (#1296) |

A check is **skipped, never guessed**, when either side cannot be classified confidently. An
unresolvable TypeScript alias produces no finding rather than a false one. Optional fields
(`x?: T`) are exempt from the nullability check, because in this codebase `?` already carries
the "only present under some conditions" meaning — an `?expand=` payload, for instance.

`array_item_type` is deliberately narrow, not a general structural recursion into array
elements. Every check above reduced an array field to the single family `array` on both sides
and stopped, which missed real drift: `BoardPublic.swimlanes` was typed `Swimlane[]` while the
serializer's `items` schema was a `$ref` to `PublicSwimlane`, a narrower shape (#1140) that
deliberately drops `custom_field_values`, `contact_email`, and `notes`. Every array-typed field
on all 44 pairs mapped before #1296 had this blind spot. The check only fires when *both* sides
name something comparable:

- The schema's `items` must resolve to a direct `$ref` (optionally through one level of `allOf`
  wrapping — the same shape `_unwrap_schema` already follows for a plain field). An inline item
  schema or a primitive item has no name to compare and is left to the outer `array`-vs-`array`
  check.
- That `$ref`'s component name must itself be a `COMPONENT_MAP` key — the same map the whole
  gate is keyed on, so there is no second table for "what should this item be". If the item's
  component is **not** mapped, the check is silently skipped, the same "skip, don't guess" rule
  every other check here follows — see [What is not covered, and why](#what-is-not-covered-and-why)
  for what that specific gap means in practice.
- On the TypeScript side, only a bare capitalised identifier before `[]` (or inside
  `Array<...>`) counts as a named element type; an inline object literal or a primitive element
  is skipped the same way an unmapped schema item is.

## Coverage

`COMPONENT_MAP` in the script is authoritative. As of #1296 it is:

| Schema component | TypeScript interface | Also name-checked by #821 |
|---|---|---|
| `Board` | `Board` | yes |
| `AdminUser` | `AdminUser` | no |
| `BoardExportLog` | `BoardExportLogEntry` | no |
| `BoardFull` | `BoardFull` | yes |
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

The mapping is **not** keyed on the two names matching. There is no `User` component — the
`/api/v1/auth/me/` shape is `CurrentUser` — and `CardChecklist` is the component behind the
`CardChecklistItem` interface. Both are one resource under two spellings, and leaving either
out would be a hole the gate's own name check cannot see. `ExternalRef`/`CardExternalRef` is
the same shape again: `ExternalRefSerializer` is a plain `serializers.Serializer` nested on
`Card.external_ref` rather than a top-level `ModelSerializer`, which is why it was missed when
the map was built and stayed missing — undetected — until #1282 added it. Diffing the two
found no drift.

#1282's completeness-check widened the audit past #821's own name-checked list (which only
sees `ModelSerializer`/`Serializer` subclasses it imports directly) and found four more
components with a real, hand-maintained TypeScript interface on the other end that had simply
never been added to the map:

- `PublicAssignee` (`PublicAssigneeSerializer`, the display-name-only user on a public
  share-link card) — identical name on both sides, the same miss as `ExternalRef` above, just
  without a rename to make it visible.
- `LinkedCard` (`LinkedCardSerializer`, the compact card reference on a `CardRelation`, #449) →
  `RelatedCardRef` — a renamed pair, same shape as `CardChecklist`/`CardChecklistItem`.
- `BoardExportLog` (`BoardExportLogSerializer`, the export-history audit row, #842/#980) →
  `BoardExportLogEntry` — another renamed pair.
- `ShareBoardResponse` (an `inline_serializer` in `boards/views/boards.py`, backing
  `POST /api/v1/boards/{id}/share/`) → `ShareActionResponse`, the interface
  `enableBoardSharing()` actually imports in `frontend/src/api/boards.ts`. Its sibling
  `UnshareBoardResponse` stays unmapped — see [What is not covered](#what-is-not-covered-and-why).

All four diffed clean — no real drift found on any of them.

A later pass of this same audit found a fifth, different-shaped miss: `PublicBoard`
(`PublicBoardSerializer`, the outer `{uid, name, columns, swimlanes, labels, cards}` shape at
`GET /api/share/{token}/`) had been *documented* as having no TypeScript interface, in "What is
not covered, and why" below — but `BoardPublic` in `frontend/src/types/index.ts` is exactly
that shape, just under a renamed name, the same pattern as `CurrentUser`/`User`. That was a
documentation error, not a structural gap, and #1282 fixed the record and mapped the pair.
`BoardPublic.swimlanes` was typed `Swimlane[]` rather than a dedicated `PublicSwimlane[]` at the
time, and this gate's array check then compared only the outer `array` family and did not
recurse into item shapes, so that looseness produced no finding and needed no suppression.
#1296 closed the gap on both sides: it added an `array_item_type` check (see
[What it checks](#what-it-checks)) that follows a schema array's `items` `$ref` and compares it
against the TypeScript element type, and it gave the public swimlane shape its own
`PublicSwimlane` interface (matching `PublicSwimlaneSerializer` exactly — see
[What is not covered, and why](#what-is-not-covered-and-why) for why that pair was excluded
before) so `BoardPublic.swimlanes` could be correctly typed `PublicSwimlane[]` and the new check
had something correct to compare it against. `PublicSwimlane` is now mapped in
[Coverage](#coverage) above.

#1294 closed the structural gap the reverse sweep found (see
[What is not covered, and why](#what-is-not-covered-and-why) below): twelve of the thirteen
pairs listed there had no schema component only because nothing in their view ever called
`@extend_schema` or set `serializer_class`. Adding that annotation — never a runtime, queryset,
or permission change — gave each one a real component, now mapped above:
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
  auto-generated (non-nullable) PK field could not describe, so `id` is now declared explicitly
  with `allow_null=True`.
- A genuine **TypeScript-only field**: `GroupInviteLink.token` is appended to
  `GroupInviteLinkSerializer(...).data` by hand, once, only on the creation response — the same
  shape as `AdminInviteLink`/`CreatedAdminInviteLink`, but without a second interface, so
  `GroupInviteLink.token` is optional and now listed in `TS_ONLY_FIELDS` rather than treated as
  drift.

The thirteenth, `LensConnection`, stays excluded — see
[What is not covered, and why](#what-is-not-covered-and-why) for the reason, which is
structural rather than something a decorator can fix.

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
construction cannot see an interface whose serializer never reaches the schema at all. The
correct sweep runs the other direction: every `export interface` in
`frontend/src/types/index.ts`, checked against `COMPONENT_MAP`'s values and the "opposite
reason" table below. That reverse sweep turned up sixteen TypeScript interfaces across thirteen
pairs, each backed by a real serializer (or, for `SiteConfig`, a view that built its response by
hand) that `drf-spectacular` published no component for — because nothing in their view called
`@extend_schema` or set `serializer_class`, the two things spectacular actually introspects. An
interface with **no** backing serializer at all — `FieldDefinitionShape` (a structural subtype
satisfied by two already-mapped interfaces, not its own shape), `SwimlaneCustomFieldValue`
(carried inside `Swimlane.custom_field_values`, not its own component — see `_DRIFT_PAIRS`'
comment in `test_ts_serializer_drift.py`), and the `Lens*` / `TrelloImport*` interfaces (plain
dataclasses serialized by hand, not DRF serializers) was not this bug class and was never listed
here.

**#1294 closed twelve of those thirteen pairs** by adding the missing `@extend_schema`
annotation (or, for `SiteConfig` and the two `Created*` creation responses, an `inline_serializer`
/ subclass documenting the hand-built response) to each view — annotation only, no runtime,
queryset, or permission change. All twelve are now mapped; see
[Coverage](#coverage) and the note above it for the drift each one surfaced and how it was fixed.

The thirteenth stays excluded, for a reason that is structural rather than something a decorator
can fix:

| Pair | Why excluded |
|---|---|
| `LensConnection` (`LensConnectionSerializer`, `LensConnectionView`, `backend/git_lens/`) | The `git_lens` app — and every one of its URLs, including `LensConnectionView` — is only installed/routed when `GIT_LENS_ENABLED=true` (`visiban/urls.py`, `visiban/settings.py`). Neither `serializer-ts-parity` nor `backend-schema-validate` sets that flag (only the dedicated `backend-test-git-lens` job does, "and nowhere else" per its own comment in `.gitlab-ci.yml`), so the schema those jobs generate never contains a `LensConnection` component to diff against — mapping it would make the gate fail in CI even though nothing is wrong. `LensConnectionView.get`/`.put` do now carry `@extend_schema` (#1294), so the component exists and is accurate whenever the schema *is* generated with the flag on (local dev, or a future CI job that sets it) — only the always-on parity job's environment is the blocker. Tracked in #1306. |

Two pairs are absent for the opposite reason — the schema has a component but there is no
TypeScript interface to diff it against. Confirmed by grepping all of `frontend/src` (not just
`types/index.ts` — the `api/*.ts` call sites are where a renamed interface would actually be
consumed) for each of these two; neither turned up a renamed or differently-named interface the
way `PublicBoard`/`BoardPublic` turned out to be one:

| Pair | Why excluded |
|---|---|
| `CardQuery` (`CardQuerySerializer`, `GET /api/v1/cards/`, #1112) | No TypeScript interface exists — `frontend/src/api/cards.ts` has no caller of this endpoint yet. Mapping it to the closest interface, `Card`, would not work: `CardQuery` sends every `Card` field plus `board` by design (a cross-board list must say which board each row is on), so the pair would report a permanent `missing_in_ts: board` finding that is not real drift. Revisit once a frontend consumer exists and needs its own interface (#1172). |
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
`2` is kept distinct from `1` so a gate that could not run is never mistaken for a clean tree.

## When the gate fails

Read which direction it drifted, then fix the side that is wrong — **not** whichever is
quicker to edit.

- **`missing_in_ts`** — you added a serializer field. Add it to the interface in the same MR.
- **`missing_in_schema`** — usually a serializer field that was removed. Confirm it is
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
  traversing `source`) does not inherit `null=True` from the model the way an auto-generated
  `ModelSerializer` field does. Add `allow_null=True`. On a `read_only` field this is
  schema-only.
- **`enum_members`** — the choice sets diverged. Decide which is authoritative before editing.

A word on `nullability`, because #1139 hit both directions of it in one branch and they have
opposite fixes:

- The **schema** understates it. A declared field (nested serializer, or a `CharField` with a
  traversing `source`) over a model FK with `null=True` publishes as non-nullable while the
  response has always been able to carry `null`. Add `allow_null=True`. On a `read_only` field
  that is a documentation fix, not a contract change.
- The **TypeScript** overstates it. A `CharField` with `null=False, blank=True, default=""`
  returns `""` and never `null`, so a `string | null` interface describes a payload the API
  cannot produce. Narrow the interface — and check the test fixtures, which tend to encode the
  impossible shape too.

Read the model field before choosing. The two cases look identical in the gate's output and
the wrong fix in either direction is a lie in the opposite place.

## Suppressions

Real, already-tracked drift is recorded in the `SUPPRESSIONS` table in
`scripts/check-serializer-ts-parity.py`, spelled `SUPPRESSED-UNTIL(#N)` to match the
convention in [suppression markers](https://gitlab.com/visiban/visiban/-/issues/1092).

These suppressions are **self-invalidating**, which is the part that matters. Each records the
exact mismatch it masks — the schema type and the TypeScript type as they are today:

```python
Suppression(TYPE_FAMILY, "Board", "member_count",
            schema_repr="string", ts_repr="number", issue=1135,
            reason="SerializerMethodField returns int, described as string"),
```

When reality stops matching that record — because the cited issue's fix landed — the
suppression has done its job, and the gate **fails** asking for its removal. A suppression
therefore cannot outlive its reason, which is the usual way a suppression quietly turns a gate
green forever.

This is deliberately not an issue-state lookup: tying staleness to the observed drift needs no
network and no GitLab token, so it works offline and in a fork's pipeline.

Adding one:

- It must cite a **specific, already-filed** issue. Never a placeholder, never a number invented
  on the spot. If the drift has no tracking issue, file one first.
- Record the mismatch exactly as the gate reports it — run with `--no-suppressions` to see it.
- Do not add one for drift you could simply fix. A suppression is for a mismatch whose fix is
  out of scope for the branch in front of you, not for one that is merely inconvenient.

## TypeScript-only optional fields

A different thing from a suppression, and not interchangeable with one. Sometimes a single
interface stands in for several serializers of one resource:

- `Swimlane` unions `SwimlaneSerializer` and `SwimlaneAdminSerializer` — `contact_email` and
  `notes` are withheld from viewer-role members as PII, and only the public serializer reaches
  the schema.
- `Group` unions the list and retrieve serializers — `ancestors` is on `GroupDetailSerializer`
  only, deliberately omitted from the list one to avoid an N+1 ancestor walk per row.

`?` is how the codebase spells "present only on some of them", so these fields produce a
`missing_in_schema` finding that is not drift. They are listed in `TS_ONLY_FIELDS` in the script
with their reason. #821's test records the identical fact in its `extra_allowed_fields_on_ts`
column, so this mirrors a reviewed convention rather than inventing a second one.

These entries cite **no issue**, because nothing is broken and there is nothing to fix. Three
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
`COMPONENT_MAP` out of the gate rather than hard-coding the pair list, so adding a pair does not
silently invalidate them.

## What is out of scope

**WebSocket event payloads.** The `{event, data}` contract in
`frontend/src/hooks/useBoardSocket.ts` is not schema-derived and is not checked here. The
schema *does* contain a `BoardEvent` component, but it describes the REST event-feed
serializer — a different shape that merely shares a name. Mapping the WebSocket union onto it
would assert a correspondence that does not exist. That union stays hand-maintained;
[#1078](https://gitlab.com/visiban/visiban/-/issues/1078) covers WebSocket event reachability
separately.

**Pairs with a component but no TypeScript interface.** `CardQuery` and `UnshareBoardResponse`
— see [What is not covered, and why](#what-is-not-covered-and-why). (`PublicSwimlane` was in
this category until #1296 gave it a dedicated interface.)

**Request bodies.** `SPECTACULAR_SETTINGS` sets `COMPONENT_SPLIT_REQUEST: True`, so the schema
carries 34 separate `*Request` / `Patched*Request` components describing what you may *send*.
This gate compares **response** components only. A write-only field whose type drifts triggers
the job (it is still a `backend/**/*` change) but produces no finding. If the frontend grows
explicit request-body interfaces, mapping them is the natural extension.

**Nothing else, with one standing exception.** Every schema component that has a matching
TypeScript interface *and reaches the schema this gate's own environment generates* is mapped as
of [#1294](https://gitlab.com/visiban/visiban/-/issues/1294), so a green `serializer-ts-parity`
run means "the published response components and the interfaces agree", not "forty-five of them do".
`LensConnection` is the sole component this job cannot see at all, for the feature-flag reason in
[What is not covered, and why](#what-is-not-covered-and-why) — not a gap in `COMPONENT_MAP`, a
gap in what the job's own schema generation includes. If you add a serializer *and* an
interface, add the pair to `COMPONENT_MAP` in the same MR — the gate does not discover pairs on
its own, and an unmapped pair is unchecked silently.
