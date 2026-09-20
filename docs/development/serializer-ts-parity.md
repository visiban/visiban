# Serializer ↔ TypeScript parity

`CLAUDE.md` states the rule plainly:

> `Board`, `Card`, `User`, and related interfaces must match the backend serializer fields exactly — when a new serializer field is added, update the corresponding TypeScript interface in the same MR.

Two checks enforce it, and they cover different things. **Read this section before assuming
either one covers your change.**

| Check | Source of truth | Covers | Checks |
|---|---|---|---|
| `backend/boards/tests/test_ts_serializer_drift.py` (#821, since 1.1) | The serializer classes (`instance.fields`) | **14** pairs, incl. `BoardFull`, `Column`, `Swimlane`, `Label`, `CardMovement`, `CardComment`, `CardActivity`, `CardAttachment` | Field **names**, both directions |
| `serializer-ts-parity` CI job (#1079, this page) | The **generated OpenAPI document** | **5** pairs — `Board`, `Card`, `User`, `BoardMembership`, `BoardUser` | Names, **types**, nullability, enum membership |

The older test covers more pairs; this gate covers more *per pair*. Neither supersedes the
other, and a green run of one says nothing about the other.

The distinction that matters: #821 asks "does the serializer emit this field?" — this gate
asks "does the document we publish describe it correctly?" A field can pass the first and fail
the second, and in practice several do. Eight fields on `Board` and `CurrentUser` were
published as `string` while returning ints, bools and nested objects (#1135); `BoardFull.members`
sends rows the `BoardMembership` component forbids (#1137); two nullable fields are declared
non-nullable (#1138). Every one of those passes #821's name check, because the serializer
really does emit the field — it is the *published type* that is wrong, and the published type
is what an external consumer generates a client from.

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
its components against the hand-written interfaces:

| Schema component | TypeScript interface |
|---|---|
| `Board` | `Board` |
| `Card` | `Card` |
| `CurrentUser` | `User` |
| `BoardMembership` | `BoardMembership` |
| `BoardUser` | `BoardUser` |

There is no `User` component — the `/api/v1/auth/me/` shape is `CurrentUser`, which is why the
mapping is not one-to-one by name.

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

## Self-test

Per the house rule in [#1093](https://gitlab.com/visiban/visiban/-/issues/1093), this gate
ships a `--self-test` mode, and CI runs it **immediately before** the real invocation on the
same image. A gate that has stopped detecting anything looks exactly like a clean codebase; the
self-test builds a synthetic schema and interface carrying one instance of every finding kind,
asserts each is caught, and asserts that a matching pair stays silent and that the suppression
machinery both suppresses and goes stale. It needs no network and no database.

## What is out of scope

**WebSocket event payloads.** The `{event, data}` contract in
`frontend/src/hooks/useBoardSocket.ts` is not schema-derived and is not checked here. The
schema *does* contain a `BoardEvent` component, but it describes the REST event-feed
serializer — a different shape that merely shares a name. Mapping the WebSocket union onto it
would assert a correspondence that does not exist. That union stays hand-maintained;
[#1078](https://gitlab.com/visiban/visiban/-/issues/1078) covers WebSocket event reachability
separately.

**`BoardFull`.** `drf-spectacular` does not currently emit a component for it, so
`BoardFullSerializer`'s response shape is unchecked *here*. #821's test does name-check it via
serializer introspection. Extending this gate there depends on that component existing first.

**Request bodies.** `SPECTACULAR_SETTINGS` sets `COMPONENT_SPLIT_REQUEST: True`, so the schema
carries 34 separate `*Request` / `Patched*Request` components describing what you may *send*.
This gate compares **response** components only. A write-only field whose type drifts triggers
the job (it is still a `backend/**/*` change) but produces no finding. If the frontend grows
explicit request-body interfaces, mapping them is the natural extension.

**The other ten pairs.** `CardComment`, `CardMovement`, `CardRelation`, `Column`,
`CustomFieldDefinition`, `CustomFieldValue`, `Group`, `GroupLabel`, `Label` and `Swimlane` all
have both a schema component and a TypeScript interface, and all are name-checked by #821, but
none get a *type* check yet. [#1139](https://gitlab.com/visiban/visiban/-/issues/1139) tracks
closing that gap. Until it does, a green `serializer-ts-parity` run means "the five mapped
pairs agree", not "the API and the frontend agree".
