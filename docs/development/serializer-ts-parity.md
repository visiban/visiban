# Serializer ↔ TypeScript parity

Two CI checks enforce the parity rule `CLAUDE.md` states plainly:

> `Board`, `Card`, `User`, and related interfaces must match the backend serializer fields exactly — when a new serializer field is added, update the corresponding TypeScript interface in the same MR.

They cover different things. **Read this section before assuming either one covers your
change.**

| Check | Source of truth | Covers | Checks |
|---|---|---|---|
| `backend/boards/tests/test_ts_serializer_drift.py` (#821, since 1.1) | The serializer classes (`instance.fields`) | **15** pairs, incl. `BoardFull`, `CardActivity`, `CardAttachment` | Field **names**, both directions |
| `serializer-ts-parity` CI job (#1079 + #1139 + #1209, this page) | The **generated OpenAPI document** | **24** pairs — every pair that has a schema component | Names, **types**, nullability, enum membership |

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

Six kinds of mismatch are reported:

| Check | Fires when |
|---|---|
| `missing_in_ts` | A serializer sends a field no interface declares |
| `missing_in_schema` | An interface declares a field no serializer sends |
| `type_family` | Both declare a type and the families disagree (string / number / boolean / array / object) |
| `untyped_schema` | The schema declares no resolvable type at all — a `JSONField` or bare `Field` reaching the client as `unknown` |
| `nullability` | One side admits `null` and the other does not |
| `enum_members` | Both resolve to a set of string values and the sets differ |

A check is **skipped, never guessed**, when either side cannot be classified confidently. An
unresolvable TypeScript alias produces no finding rather than a false one. Optional fields
(`x?: T`) are exempt from the nullability check, because in this codebase `?` already carries
the "only present under some conditions" meaning — an `?expand=` payload, for instance.

## Coverage

`COMPONENT_MAP` in the script is authoritative. As of #1137 it is:

| Schema component | TypeScript interface | Also name-checked by #821 |
|---|---|---|
| `Board` | `Board` | yes |
| `BoardFull` | `BoardFull` | yes |
| `BoardMembership` | `BoardMembership` | yes |
| `BoardUser` | `BoardUser` | yes |
| `Card` | `Card` | yes |
| `CardActivity` | `CardActivity` | yes |
| `CardAttachment` | `CardAttachment` | yes |
| `CardChecklist` | `CardChecklistItem` | yes |
| `CardComment` | `CardComment` | yes |
| `CardMovement` | `CardMovement` | yes |
| `CardRelation` | `CardRelation` | no |
| `Column` | `Column` | yes |
| `CurrentUser` | `User` | no |
| `CustomFieldDefinition` | `CustomFieldDefinition` | no |
| `CustomFieldValue` | `CustomFieldValue` | no |
| `EffectiveBoardMember` | `EffectiveBoardMember` | no |
| `Group` | `Group` | no |
| `GroupBrief` | `GroupBrief` | no |
| `GroupLabel` | `GroupLabel` | no |
| `Label` | `Label` | yes |
| `Notification` | `Notification` | no |
| `PublicCard` | `PublicCard` | no |
| `Swimlane` | `Swimlane` | yes |
| `SwimlaneCustomFieldDefinition` | `SwimlaneCustomFieldDefinition` | yes |

The mapping is **not** keyed on the two names matching. There is no `User` component — the
`/api/v1/auth/me/` shape is `CurrentUser` — and `CardChecklist` is the component behind the
`CardChecklistItem` interface. Both are one resource under two spellings, and leaving either
out would be a hole the gate's own name check cannot see.

### What is not covered, and why

Until #1209, two pairs #821 name-checks were absent here for a structural reason: the schema
had no component to diff against, so there was nothing this gate could compare. `CardActivity`
and `CardAttachment` backed endpoints (`CardViewSet.activities`/`.attachments`) that fell back
to the viewset's default `CardSerializer` with no dedicated response wiring, so
`drf-spectacular` published the wrong component entirely rather than none. #1209 gave both
endpoints real `@extend_schema` response annotations, so both are now mapped and checked (see
[Coverage](#coverage)). The same issue also wired `NotificationListView` and `ShareBoardView`
for the first time, adding `Notification` and `PublicCard` to the map.

Two pairs are absent for the opposite reason — the schema has a component but there is no
TypeScript interface to diff it against:

| Pair | Why excluded |
|---|---|
| `CardQuery` (`CardQuerySerializer`, `GET /api/v1/cards/`, #1112) | No TypeScript interface exists — `frontend/src/api/cards.ts` has no caller of this endpoint yet. Mapping it to the closest interface, `Card`, would not work: `CardQuery` sends every `Card` field plus `board` by design (a cross-board list must say which board each row is on), so the pair would report a permanent `missing_in_ts: board` finding that is not real drift. Revisit once a frontend consumer exists and needs its own interface (#1172). |
| `PublicBoard` (`PublicBoardSerializer`, `GET /api/share/{token}/`, #1209) | No TypeScript interface exists — the SPA's share-link view only reads the nested `cards` list, for which `PublicCard` (mapped above) already exists. Revisit if a frontend consumer needs the outer `{uid, name, columns, swimlanes, labels, cards}` shape as its own type. |

Everything else is deliberately in scope and mapped. There is no pair that has a component, an
interface, and is simply not checked.

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

**Pairs with a component but no TypeScript interface.** `CardQuery` and `PublicBoard` — see
[What is not covered, and why](#what-is-not-covered-and-why).

**Request bodies.** `SPECTACULAR_SETTINGS` sets `COMPONENT_SPLIT_REQUEST: True`, so the schema
carries 34 separate `*Request` / `Patched*Request` components describing what you may *send*.
This gate compares **response** components only. A write-only field whose type drifts triggers
the job (it is still a `backend/**/*` change) but produces no finding. If the frontend grows
explicit request-body interfaces, mapping them is the natural extension.

**Nothing else.** Every schema component that has a matching TypeScript interface is mapped as
of [#1139](https://gitlab.com/visiban/visiban/-/issues/1139), so a green `serializer-ts-parity`
run now means "the published response components and the interfaces agree", not "five of them
do". If you add a serializer *and* an interface, add the pair to `COMPONENT_MAP` in the same MR —
the gate does not discover pairs on its own, and an unmapped pair is unchecked silently.
