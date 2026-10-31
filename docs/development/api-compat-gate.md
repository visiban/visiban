# CI blocks any removal from the REST schema or env var names

Run `python3 scripts/check-api-compat.py` to see what the `api-compat-check` CI job (#1667) sees: it diffs the REST schema and the operator-facing environment variable names against the last GA tag on every MR and on `main`.

**Why it matters:** Visiban 1.0+ treats both as a public contract (see "Backward compatibility" in `CLAUDE.md`), so a removal can no longer slip through on a green pipeline.

**The big picture:** It is a sibling of `backend-schema-validate` (is the document well formed?) and `backend-schema-fuzz` (does the API match the document?). This job asks a third question: does today's contract still contain everything the last release promised?

**Go deeper:** [Allow-list a deliberate break](#allow-listing-a-deliberate-break), [mark an operation experimental](#experimental-operations), and [roll the baseline at each GA tag](#regenerating-the-baseline-at-each-ga-tag).

## What it checks

**OpenAPI.** The schema `manage.py spectacular` emits for the branch is compared with `scripts/compat-baseline/v1.1.0/openapi.json`. `$ref` and `allOf` are resolved on both sides, so a renamed component is not a finding; only what a client can observe is.

| Finding | Meaning |
|---|---|
| `REMOVED_OPERATION` | A path + method present in the baseline is gone |
| `REMOVED_RESPONSE_STATUS` | A 2xx status the baseline documented is gone |
| `REMOVED_RESPONSE_FIELD` / `REMOVED_REQUEST_FIELD` | A property was removed |
| `TYPE_CHANGED` | A property, parameter, or body changed type |
| `RESPONSE_FIELD_BECAME_OPTIONAL` | A response property is no longer always present |
| `RESPONSE_BECAME_NULLABLE` | A response property may now be `null` |
| `REQUEST_FIELD_BECAME_REQUIRED`, `NEW_REQUIRED_REQUEST_FIELD`, `NEW_REQUIRED_REQUEST_BODY` | Existing clients now fail validation |
| `REQUEST_STOPPED_ACCEPTING_NULL`, `REQUEST_ENUM_VALUE_REMOVED` | A request value that used to be accepted is not |
| `REMOVED_PARAMETER`, `PARAMETER_BECAME_REQUIRED`, `NEW_REQUIRED_PARAMETER`, `PARAMETER_TYPE_CHANGED` | The same, for query/header/path parameters |
| `REMOVED_REQUEST_MEDIA_TYPE`, `REMOVED_RESPONSE_MEDIA_TYPE` | A content type is no longer offered |

- **Always passes:** additions (new endpoints, new optional fields, new optional parameters).
- **Not checked:** error statuses (4xx/5xx).
- **Untyped fallback:** a baseline property that is a bare read-only `string` is treated as untyped. It is drf-spectacular's fallback for an unannotated `SerializerMethodField`, so correcting it to its real type is not a break.

**Settings.** Every env var name that `backend/visiban/settings.py` reads at the GA tag must still be read at HEAD. The gate counts these reads: `env(...)`, `env.<type>(...)`, `_secret_env(...)`, `os.environ`/`os.getenv`, the legacy name passed to `_warn_deprecated_env_alias`, and both names passed to `_env_alias_name`. A deprecated alias that is kept counts as present, which is exactly the rename policy in `CLAUDE.md`. The baseline is `scripts/compat-baseline/v1.1.0/settings-env.txt`.

## Component names are not part of the contract

The gate resolves `$ref` and `allOf`, so a renamed component is never a finding. A generated client does turn a component name into a type name, so decide a rename once and record it:

- **Pin the old name** (`@extend_schema_serializer(component_name=...)`) only when a plain rename is the whole change, as #1825 did for dj-rest-auth's password request bodies.
- **Otherwise keep the new name** and list the old-to-new mapping in the upgrade guide. #1834 did this for `/auth/user/` (`User` to `CurrentUser`) and for the dj-rest-auth response components. Pinning `User` back would have collided with `UserSerializer`'s component, which `POST /auth/choose-username/` returns, so one of the two would have needed a rename anyway.

**Watch out:** Decide before the baseline roll. The roll freezes whatever names the schema has that day.

Decided in #1874, ahead of the first baseline roll that contains them (none of the names below exist in the v1.1.0 baseline, so nothing shipped was renamed):

- **No `*RequestRequest` components.** `COMPONENT_SPLIT_REQUEST` already appends `Request` to a request component, so an `inline_serializer(name="...")` on a `request=` must not end in `Request`. Use `name="CardMove"` to get `CardMoveRequest`. This applied to the card move, checklist/column/custom-field/swimlane/swimlane-custom-field reorder, board share, add-or-update-member, and personal-access-token create bodies. The share body's expiry enum is now `ShareBoardExpiresInDaysEnum`.
- **List endpoints get `_list` operationIds.** `api_v1_admin_action_log_list`, `api_v1_admin_board_invite_links_list` and `api_v1_boards_events_list` are set explicitly with `operation_id=`, because the generator names a non-`ViewSet` `APIView` GET, and the `events` action, `_retrieve`.
- A 1.1 name that shipped keeps its name; only 1.2-new names were changed.

`backend/boards/tests/test_schema_generated_names_1874.py` fails if a `*RequestRequest` component or one of those `_retrieve` operationIds reappears.

## Environment variable naming

Env var names freeze the same way, and the gate cannot tell a good name from a bad one. Decided in #1873 for every name added from 1.2 on:

- **No product prefix on functional settings.** Name them `<FEATURE>_<NOUN>[_<UNIT>]`, like `BOARD_EVENT_RETENTION_DAYS`, `NOTIFICATION_EMAIL_TIMEOUT` and `GIT_LENS_ENABLED`. Almost every pre-1.2 variable is already unprefixed, and a prefix on some settings but not others is how the inconsistency starts.
- **Put the unit in the name when the value has one**: `_BYTES`, `_DAYS`, `_SECONDS`. A size without `_BYTES` reads as megabytes to half of all operators.
- **A name that mirrors an upstream setting keeps the upstream name and unit.** Django, DRF and allauth settings read from the environment use their own names (`EMAIL_TIMEOUT`, `NUM_PROXIES`), and a feature-scoped copy follows it. `NOTIFICATION_EMAIL_TIMEOUT` is in seconds, like the `EMAIL_TIMEOUT` it mirrors, so it carries no `_SECONDS`.
- **Feature on/off switches end in `_ENABLED`** (`MCP_SERVER_ENABLED`, `GIT_LENS_ENABLED`). A boolean that picks a mode of a feature that is already on says what the mode is (`NOTIFICATION_EMAIL_ASYNC`).
- **A switch that turns the whole instance into a named mode ends in `_MODE`** (`DEMO_MODE`). It is not a feature toggle: it changes what the instance is (a public, write-fenced demo). The name states the mode, so it has no `_ENABLED`.
- **Throttle rates are `<FEATURE>_THROTTLE_<SCOPE>_RATE`**, like `MCP_THROTTLE_READ_RATE` and `DEMO_THROTTLE_USER_RATE`, so a feature's limits sort together.
- **The `VISIBAN_` prefix is reserved for two kinds of variable.** One is key material that Visiban itself uses to protect data (`VISIBAN_SECRET_ENCRYPTION_KEY`). The other is a test- or CI-only input that a production install must never set (`VISIBAN_DISABLE_THROTTLING`, `VISIBAN_GIT_LENS_STUB_PROVIDERS`, `VISIBAN_FUZZ_TOKEN_FILE`). The prefix marks them as not ordinary tuning knobs. Other secrets are credentials for an external service or an account, such as `REDIS_URL_PASSWORD` or `DEMO_LOGIN_PASSWORD`. They are named like any other setting, `<FEATURE>_<NOUN>`, without the prefix.
- **Fixing a name that has shipped** (in any release, pre-releases included) means adding the new name and keeping the old one as a working, deprecated alias. Use the helpers in `backend/visiban/env_aliases.py`. They are pure stdlib, so `settings.py` and code outside it, such as a management command, can both import them without a cycle. **Import them under their underscore names**, as `settings.py` and `migrate_with_lock.py` do:

  ```python
  from visiban.env_aliases import env_alias_name as _env_alias_name
  from visiban.env_aliases import warn_deprecated_env_alias as _warn_deprecated_env_alias
  ```

  - **Why the names matter:** This gate (`scripts/check-api-compat.py`) and the chart's reader check (`scripts/helm-structure-check.sh` section 3) match calls to `_env_alias_name(...)` and `_warn_deprecated_env_alias(...)` by those names, with the variable names as string literals. A call under any other name, or with a name passed through a variable, is invisible to both.
  - `_env_alias_name("NEW", "OLD")` picks which name to read: the new name wins when it is non-empty.
  - `_warn_deprecated_env_alias("OLD", "NEW")` logs the startup warning. Pass `removed=True` for an old name that is no longer read at all, so the warning says it has no effect.
  - List the alias in the deprecated-names table in `docs/administration/configuration.md`.

Applied in #1873, before the first baseline roll that contains them. None of the old names is in the v1.1.0 baseline, but all of them shipped in 1.2 pre-releases (from `v1.2.0-alpha.1` on), so all of them are still read:

| Pre-release name (deprecated alias) | Canonical name | Read in |
|---|---|---|
| `VISIBAN_IMPORT_MAX_SIZE` | `IMPORT_MAX_SIZE_BYTES` | `visiban/settings.py` |
| `DEMO_USER_THROTTLE_RATE` | `DEMO_THROTTLE_USER_RATE` | `visiban/settings.py` |
| `VISIBAN_MIGRATE_CONNECT_TIMEOUT` | `MIGRATE_CONNECT_TIMEOUT_SECONDS` | `boards/management/commands/migrate_with_lock.py` |
| `VISIBAN_MIGRATE_LOCK_TIMEOUT` | `MIGRATE_LOCK_TIMEOUT_SECONDS` | `boards/management/commands/migrate_with_lock.py` |

The Django setting `settings.VISIBAN_IMPORT_MAX_SIZE` keeps its name. Settings attributes are internal, and renaming it would only churn callers. `backend/accounts/tests/test_deprecated_env_aliases.py` and `backend/boards/tests/test_migrate_with_lock.py` cover the resolution order.

### Inventory of the names new in 1.2

`--dump-env` given a directory runs the gate's AST-based `env_names()` over every non-test `.py` file under it. It skips `tests/` directories, `test_*.py` and `conftest.py`. That covers lookups split across lines and the `JobSpec(name, "ENV", default)` entries in `run_scheduler.py`, which a per-line grep misses. Run it from the repository root to re-check the list:

```bash
TMP=$(mktemp -d)
git archive v1.1.0 backend | tar -x -C "$TMP"
( cd "$TMP" && python3 "$OLDPWD/scripts/check-api-compat.py" --dump-env backend ) > "$TMP/old.txt"
python3 scripts/check-api-compat.py --dump-env backend > "$TMP/new.txt"
comm -13 "$TMP/old.txt" "$TMP/new.txt"   # names new since v1.1.0
comm -23 "$TMP/old.txt" "$TMP/new.txt"   # names gone since v1.1.0 (must be empty)
```

The `cd` matters: the script only reads paths under the repository, the system temp directory or the current directory. When this was last run for #1873, no name was gone. Every new name is either one of the four renamed pairs above or in this table:

| Name | Rule it follows |
|---|---|
| `BOARD_EVENT_RETENTION_DAYS`, `NOTIFICATION_RETENTION_DAYS` | `<FEATURE>_<NOUN>_<UNIT>` |
| `NOTIFICATION_EMAIL_ENABLED`, `INVITE_EMAIL_ENABLED`, `GIT_LENS_ENABLED`, `MCP_SERVER_ENABLED` | on/off switch ends in `_ENABLED` |
| `NOTIFICATION_EMAIL_ASYNC` | mode of a feature that is already on |
| `NOTIFICATION_EMAIL_TIMEOUT` | mirrors Django's `EMAIL_TIMEOUT` (seconds) |
| `EMAIL_TIMEOUT`, `EMAIL_USE_SSL`, `NUM_PROXIES` | upstream Django/DRF names |
| `GIT_LENS_OUTBOUND_LOG_LEVEL`, `MCP_ALLOWED_HOSTS` | `<FEATURE>_<NOUN>` |
| `REDIS_URL_PASSWORD` | `<FEATURE>_<NOUN>`: credential for an external service, so no reserved prefix |
| `MCP_THROTTLE_READ_RATE`, `MCP_THROTTLE_COMPUTE_RATE`, `MCP_THROTTLE_PREAUTH_RATE` | `<FEATURE>_THROTTLE_<SCOPE>_RATE` |
| `DEMO_MODE` | named instance mode, ends in `_MODE` |
| `DEMO_LOGIN_USERNAME`, `DEMO_RESET_SCHEDULE` | `<FEATURE>_<NOUN>` |
| `DEMO_LOGIN_PASSWORD`, `DEMO_ADMIN_PASSWORD`, `DEMO_MEMBER_PASSWORD` | `<FEATURE>_<NOUN>`: account credentials, so no reserved prefix |
| `SCHEDULE_NOTIFY_DUE_SOON`, `SCHEDULE_NOTIFY_STALE_CARDS`, `SCHEDULE_PRUNE_BOARD_EVENTS`, `SCHEDULE_PRUNE_NOTIFICATIONS` | `<FEATURE>_<NOUN>`: the scheduler's `SCHEDULE_<JOB>` family, read through `JobSpec` in `run_scheduler.py` |
| `VISIBAN_SECRET_ENCRYPTION_KEY` | reserved prefix: key material Visiban uses to protect data |
| `VISIBAN_DISABLE_THROTTLING`, `VISIBAN_GIT_LENS_STUB_PROVIDERS`, `VISIBAN_FUZZ_TOKEN_FILE` | reserved prefix: test/CI-only |

Out of scope: `MUTATION_SHARD`, `MUTATION_SHARDS`, `MUTATION_TARGET`, `CI_NODE_INDEX` and `CI_NODE_TOTAL` are read only by `backend/mutmut_config.py`, the mutation-testing harness (see [Mutation testing](mutation-testing.md)). They are CI inputs, not operator settings.

## Allow-listing a deliberate break

Put an intentional break (a planned major bump, or a removal of an item already deprecated for a full release) in `scripts/compat-baseline/allowlist.json`. Every entry needs an `issue` (`#1234`) and a `reason`, and exactly one target:

```json
{"allow": [
  {"key": "REMOVED_RESPONSE_FIELD GET /api/v1/boards/ response 200 application/json .results[] .legacy_name",
   "issue": "#1700", "reason": "deprecated in 1.2, removal scheduled for 2.0"},
  {"operation": "POST /api/v1/old/", "issue": "#1701", "reason": "endpoint retired after the 410 period"}
]}
```

- `key` is the exact text the gate prints (`*` is a wildcard).
- `operation` (`"METHOD /path/"`) covers every finding under that one operation.

**Watch out:** An entry that no longer matches any finding is **stale and fails the job**, so the list can only shrink toward the truth. Entries without an issue reference fail the job outright.

Prefer `key` entries. An `operation` entry silently covers every future finding under that operation, so use it only when the whole operation is deliberately retired (the five `#1080` catch-all entries are an example). The self-test pins the opposite behavior for `key` entries: a *new* finding under an operation that already has entries still fails.

## Experimental operations

An operation documented as experimental (no stability promise until it graduates) must not freeze when the baseline is rolled. List it in `scripts/compat-baseline/experimental.json` (#1875). That file is separate from the allow-list: the allow-list excuses one specific break, this keeps a whole operation out of the contract.

```json
{"experimental": [
  {"path_pattern": "/api/v1/git-lens/*", "issue": "#1875", "reason": "documented experimental in docs/api/git-lens.md"}
]}
```

- `path_pattern` is an `fnmatch` pattern against the schema path (`*` is a wildcard).
- Every entry needs an `issue` and a `reason`; the gate fails without them.
- Matching operations are skipped on both sides of the diff, and the gate prints each skipped `METHOD /path/` in the CI log so the exemption is visible.
- An entry that matches no operation in the baseline or at HEAD is **dead and fails the job**. With `--schema FILE`, generate the schema with `GIT_LENS_ENABLED=True`, otherwise the Git Lens entries report as dead (the default run sets it for you).
- `--normalize` honors the list, so a baseline regenerated at a GA tag never contains these operations (see "Regenerating the baseline"). Components are compared only through the operations that reference them, so a component shared with a non-experimental operation is still checked through that operation.
- **When to add an entry:** only for a surface the public docs already call experimental, with a tracking issue. Do not use it to get a pipeline green.
- **Leaving experimental:** remove the entry **before** the baseline roll that should freeze the operation, and update the API doc's experimental notice in the same MR. Removing it after the roll leaves the operation permanently unfrozen.

The only entries today are the Git Lens REST endpoints. The `lens_connection.*` WebSocket events and the `git_lens_enabled` user field are deliberately frozen (#1666) and are not listed.

### Frozen snapshot of the v1.1.0 baseline drift

The v1.1.0 schema was generated before the schema-hygiene work (#1135-#1138, #1209, #1080) and documented fallback or wrong serializers for a number of operations (for example a card serializer standing in for the request body of `checklist/` and `comments/`). Diffing against it yields findings that look like documentation corrections rather than runtime changes.

A read-only comparison of the v1.1.0 and current runtime code verified these classes as **documentation-only baseline errors, not breaks**:

- `card_count` / `member_count` on `GET /boards/{id}/full/`: the v1.1.0 `BoardFullSerializer` never had them; the v1.1.0 schema showed the viewset's default `BoardSerializer`.
- `assignee` / `created_by` nullable on cards: v1.1.0 already returned `null` for the `SET_NULL` foreign keys; only the schema (`allow_null=True`) changed.
- `POST /boards/import/` `file`: v1.1.0 was already multipart-only and answered 400 "No file provided." without it.
- `object` -> `array` list responses (activities, attachments, movements, saved-filters, and the group boards / descendant-boards / invite-links / labels / subgroups actions): these hand-written `@action`s returned bare arrays in both versions; only the schema's `pagination_class` was fixed.
- 2xx status changes: an AST scan found none that differ at runtime.

The same comparison found no serializer field and no URL route removed between v1.1.0 and `main` (the `dj_rest_auth` `include()` became explicit routes, and five declarations were rewritten as same-name `SerializerMethodField`s).

Those findings are therefore frozen as exact per-finding `key` entries (generated once from the gate's own output with an empty allow-list, sorted for stable diffs). The snapshot is closed: anything not already in it, including a further change to an operation that has entries, fails the job.

**Watch out:** Never add to the snapshot to get a pipeline green. A new finding is a real break or needs its own issue-referenced entry. The temporary `#1788`, `#1783` and `#1792` entries described below are such entries; none of them is part of the burn-down count below. The exception is an operation covered by an `operation` entry (the `#1783` ones): every finding under it passes, including a new one. That is why those entries must be deleted at the v1.2.0 roll.

**Burn-down result** (#1695). Every one of the 51 operations with entries was checked against the v1.1.0 *view code* (`git show v1.1.0:backend/...`), not the v1.1.0 schema, and each entry's `reason` now records what v1.1.0 actually read and returned:

- **556 entries under `#1695` are documentation-only.** The v1.1.0 schema showed a fallback serializer for hand-written `@action`s and `APIView`s:
    - a card serializer for `move/`, `checklist/`, `comments/`, `attachments/`, `status/`, `timeline/`, `archived/`;
    - a board serializer for `share/`, `members/`, `movements/`, `export-history/`;
    - a group serializer for the group `labels/`, `members/`, `star/`, `invite-links/`, `boards/` actions.

  It also echoed the request serializer as the response for the dj-rest-auth subclasses (`login/`, `password/reset/`, `password/reset/confirm/`, `registration/`), and documented `200` where the view returned `201` (or `204` where `DELETE share/` returned `200`). None of the listed fields or statuses was ever on the wire.
- **4 entries under `#1302` are a real, deliberate runtime change**, already announced in `CHANGELOG.md`: `columns/reorder/` and `swimlanes/reorder/` used to treat a missing `order` as a `200` no-op and now answer `400` unless `order` is the board's full ID list. The upgrade-guide note for this is tracked in #1782.
- **3 `REMOVED_REQUEST_MEDIA_TYPE` entries on `POST /auth/password/change/` were a HEAD schema defect, not a removal** (#1781, fixed). `VisibanPasswordChangeSerializer.__init__` called `has_usable_password()` on `AnonymousUser` during schema generation, so HEAD's schema lost the request body. The fix replaced them with three `NEW_REQUIRED_REQUEST_FIELD ... .old_password` entries under `#1257`, the deliberate security break.

Until the baseline is rolled at the next GA, these entries stay in the file, because the drift lives in the frozen baseline itself. Deleting an entry whose finding still fires turns the job red, whether the finding is drift or a real break. Entries are only ever deleted (when one goes stale) or re-justified, never added. Exceptions:

1. the #1781 replacement above;
2. the temporary #1788 entries below;
3. the temporary #1783 entries below;
4. the #1792 entry below;
5. a permanent one: the `REMOVED_RESPONSE_STATUS DELETE /api/v1/admin/invite-links/{id}/ 204` entry under `#1912`. The v1.1.0 baseline listed `204` there (drf-spectacular's DELETE default), but v1.1.0 always answered `200` with the revoked link and `400` on a repeat revoke. That runtime contract is frozen for all of 1.x, so the schema now declares it and the entry is not removed at the v1.2.0 roll.

Delete every temporary entry below when the baseline is rolled at the v1.2.0 GA:

- **Four `key` entries under `#1788`** cover `NEW_REQUIRED_REQUEST_BODY` on `POST swimlanes/`, `PUT swimlanes/{id}/`, and `PATCH swimlanes/{id}/set-collapsed/` and `set_collapsed/`. The v1.1.0 baseline lacks those bodies because `SwimlaneViewSet` crashed during schema generation; #1788 fixes the schema, and the endpoints always required the body.
- **Sixteen `operation` entries under `#1783`** cover hand-written actions and `APIView`s whose schema showed a fallback serializer, no body, or a wrong status (for example `star/`, `move-group/`, `saved-filters/`, card `archive/` and `unarchive/`, `summary/`, `analytics/`, `export/`, the group `members/{user_id}/`, `transfer-ownership/` and `board-defaults/` actions, `auth/change-password/`, `auth/choose-username/` and `auth/registration/resend-email/`). The v1.1.0 baseline holds those wrong shapes, so each correction reads as a removal; no runtime behavior changed.
- **One `key` entry under `#1792`** covers `REQUEST_BODY_BECAME_REQUIRED` on `POST boards/import/`. The baseline published the multipart upload body as optional, but the view has always answered 400 without `file`.

**Yes, but:** The GA roll does not fix the schema by itself. It freezes the schema HEAD generates at that tag as the new baseline, so an operation that still documents a fallback serializer at the tag carries that error into the next baseline. #1783 corrected the cases its sweep confirmed. The board import request bodies were corrected in #1792; hand-written `GET`s that publish no response body are tracked in #1793. Any found later need the same fix before the following roll.

## Running it locally

```bash
cd backend && source .venv/bin/activate   # the same env the backend tests use
cd .. && python3 scripts/check-api-compat.py --self-test
python3 scripts/check-api-compat.py
bash scripts/tests/check-api-compat.test.sh
```

## Regenerating the baseline (at each GA tag)

Do this once, when a new GA tag is cut, from a clean checkout of the tag. Run it in a temporary worktree outside the repo and delete it afterward.

```bash
TAG=v1.2.0
VENV_PY="$PWD/backend/.venv/bin/python"   # run from the repository root
git worktree add --detach /tmp/visiban-$TAG $TAG
( cd /tmp/visiban-$TAG/backend \
  && DATABASE_URL=postgres://u:p@localhost:5432/d REDIS_URL=redis://localhost:6379/0 \
     DJANGO_SECRET_KEY=x DEBUG=True ALLOWED_HOSTS=localhost GIT_LENS_ENABLED=True \
     "$VENV_PY" manage.py spectacular --format openapi-json --file /tmp/$TAG.json )
mkdir -p scripts/compat-baseline/$TAG
python3 scripts/check-api-compat.py --normalize /tmp/$TAG.json scripts/compat-baseline/$TAG/openapi.json
python3 scripts/check-api-compat.py --dump-env /tmp/visiban-$TAG/backend/visiban/settings.py \
  > scripts/compat-baseline/$TAG/settings-env.txt
git worktree remove /tmp/visiban-$TAG
```

Then, as a manual step on the release checklist:

1. Point `BASELINE_SCHEMA` / `BASELINE_ENV` in `scripts/check-api-compat.py` (lines 52-53) at the new directory.
2. Delete every allow-list entry the new baseline no longer needs, and delete the old baseline directory.

`--normalize` strips prose, examples, and `x-` extensions so the fixture stays small and docs edits never read as contract changes, and drops every operation listed in `experimental.json`. Before the roll, remove the entry of any operation that should now freeze.

Every allow-list entry is a diff against the v1.1.0 baseline. Once the baseline is the v1.2.0 schema and HEAD matches it, none of those findings fire, so all entries go stale, and a stale entry fails the job. After regenerating, run `python3 scripts/check-api-compat.py`, delete every entry it reports as stale (expected: the whole list, leaving `{"allow": []}`), and re-run until it prints OK with no stale entries.

As a safety net for the temporary entries (those whose `reason` starts with `temporary:`, citing #1783, #1788, #1789 or #1792), this lists any left behind. After deleting, it must print nothing:

```bash
python3 -c "import json;[print(e['issue'],e.get('operation') or e['key']) for e in json.load(open('scripts/compat-baseline/allowlist.json'))['allow'] if e['reason'].startswith('temporary:') or e['issue'] in ('#1783','#1788','#1789','#1792')]"
```

A temporary entry left behind fails the roll MR loudly. Then, in this file:

- delete every sentence or paragraph that describes temporary entries or counts exceptions to the "never added" rule (including any added for #1789 or #1792), keeping the existing "never added" sentence as is, and
- revise the prose that describes the v1.1.0 baseline drift and allow-list burn-down (the "Frozen snapshot of the v1.1.0 baseline drift" section, the `#1080` catch-all mentions, the `v1.1.0/` paths, and the paragraph above) to the new baseline.

## Not covered

- Serializer fields that never reach the schema (the schema is the source of truth here; `serializer-ts-parity` covers frontend interfaces).
- WebSocket events: see [WebSocket event contract](websocket-event-contract.md).
- Settings *values* and defaults; only names are compared.
- Env vars read outside `backend/visiban/settings.py`, such as the `MIGRATE_*_TIMEOUT_SECONDS` pair in `migrate_with_lock`. `scripts/helm-structure-check.sh` section 3 proves that every name the chart injects has a reader under `backend/`, but nothing diffs these names against a release.
