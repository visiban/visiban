#!/usr/bin/env bash
# Sonar exclusion-integrity guard (#1380, part of the #1368 SonarCloud epic).
#
# WHY THIS EXISTS
# ---------------
# `sonar-project.properties` carries a `sonar.issue.ignore.multicriteria` list,
# each criterion scoping a rule to a path glob and each documented as a reviewed
# false positive. Nothing verified those globs still pointed at anything.
#
# The cautionary tale is TruePPM #2517: a glob pinned to `activity/*.ts` stopped
# matching after the file it excused was renamed to `.tsx` (it had grown JSX).
# Four suppressed findings reappeared, the reliability rating fell A -> D, and
# NOTHING went red: the rename was correct, nobody had reason to read the Sonar
# properties, the scan is scheduled-only, and the quality gate scores new code
# only. It surfaced days later as "reliability took a hit".
#
# A suppression that matches nothing is either dead (the code it excused is gone)
# or drifted (the code moved and is now silently un-suppressed). Both are worth
# failing on, and both are cheap to detect: it is pure path matching against
# `git ls-files`.
#
# WHAT IS CHECKED
#   1. every `<id>.resourceKey` glob matches >= 1 tracked file, using real Ant
#      semantics (`**/` = zero or more dirs, `**` = anything, `*` = no `/`,
#      `?` = one non-`/` char). Never errs toward "matched": a glob like
#      `**/est/**` is dead under Ant and must be reported dead.
#   1b. no glob is pinned to `*.ts`/`*.js` in a directory that also holds
#      `.tsx`/`.jsx` files (the #2517 drift shape), including `**` spellings
#   2. every criterion in the `multicriteria=` index has both a `.ruleKey` and a
#      `.resourceKey` defined
#   3. every defined criterion (any `.ruleKey` OR `.resourceKey`) appears in the `multicriteria=` index - a
#      criterion defined but unlisted is silently inert, the same bug from the
#      other direction
#
#   4. every `.ruleKey` is in the checked-in RULE_TITLES table below, and when
#      the comment text above a criterion cites Sonar rule numbers (`S1234`),
#      the criterion's own rule number is one of them (#1407). This catches a
#      key that does not mean what its comment says: sort_tests cited
#      "`.sort()` without localeCompare" but used S6325 (regex literals), and
#      dataset_tests cited ".dataset" but used S6330 (an AWS SQS rule). Both
#      were inert for months because check 1-3 only look at structure.
#
#   4b. every criterion's own comment block NAMES its rule (#1425): an `S<NNNN>`
#      matching the key's number, or the key's RULE_TITLES title. A sibling
#      criterion under a shared header used to be only table-checked, so a
#      copy-pasted wrong key that was in the table still passed; now each
#      sibling needs its own naming line.
#   5. ONLINE, opt-in via `--online` (#1425): every `.ruleKey` is ACTIVE in a
#      quality profile of the SonarCloud project. A rule that was valid when
#      added and later deactivated or renamed in the profile still passed
#      checks 1-4. Resolves the project's profiles
#      (api/qualityprofiles/search?project=&organization=), then lists each
#      profile's active rules (api/rules/search?qprofile=&activation=true) and
#      compares. A key missing from that bulk list is re-checked one by one with
#      api/rules/show?actives=true before it fails: the bulk search has been
#      seen to omit a rule that rules/show reports active in the project's own
#      profile (pythonsecurity:S8705, 2026-10-05), and rules/show also tells a
#      deleted/never-existed key (404) apart from a deactivated one.
#      FAILS OPEN: no SONAR_TOKEN, no jq/curl, a network error or an
#      unparseable response prints a warning and exits 0 - an infra problem must
#      never turn a pipeline red. Wired into the nightly `sonar:rules-check` job,
#      the only place a token exists; the MR job `lint:sonar-exclusions` never
#      passes --online and stays hermetic.
#
# Deliberately NOT checked (offline): whether the rule still fires. That needs a
# full SonarCloud scan; check 5 only proves the rule is switched on. Also not
# detectable here: a pattern that still matches its original file while growing
# a SECOND home elsewhere. The durable fix for that is on the code side - keep a
# suppressed pattern in ONE place so a copy has nowhere to hide.
#
# Suppression policy lives in the header of sonar-project.properties; see also
# docs/development/suppressions.md.
#
# USAGE
#   check-sonar-exclusions.sh [properties-file]
#   check-sonar-exclusions.sh --online [properties-file]   # + check 5 (needs SONAR_TOKEN)
#   check-sonar-exclusions.sh --self-test   # prove the gate fails when it should
#
# ENVIRONMENT (online mode only)
#   SONAR_TOKEN             API token; sent via curl's stdin config, never in argv
#                           or output. Absent -> online check is skipped (exit 0).
#   SONAR_HOST_URL          defaults to https://sonarcloud.io
#   SONAR_API_FIXTURE_DIR   read API responses from files in this dir instead of
#                           the network (self-test only): qualityprofiles.json and
#                           rules-<profileKey>-p<page>.json
#
# EXIT CODES
#   0  all criteria are live and consistent
#   1  at least one dead glob, drift-prone glob, index/definition mismatch,
#      unnamed/mismatched rule, or (online) a rule inactive in the profile
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# --- Rule table (check 4) ---------------------------------------------------
# Offline on purpose: asking SonarCloud whether a key is an active rule needs a
# token and network, and this job must stay hermetic and fail closed on a
# mismatch rather than open on an API outage. Instead, every rule key the file
# may reference is registered here with its real title. Adding a criterion means
# adding a row, which forces the author to look up what the rule actually is;
# the title is the review artifact. Format: <ruleKey>|<title>.
RULE_TITLES='
docker:S6470|Copying recursively (COPY . .) is security-sensitive
docker:S8544|pip install of local wheels
javascript:S2871|Array.sort() should use a compare function (localeCompare)
javascript:S4036|Searching OS commands in PATH is security-sensitive
javascript:S7761|Data attributes should be accessed using .dataset
python:S1192|String literals should not be duplicated
python:S2068|Hard-coded passwords are security-sensitive
python:S2245|Pseudorandom number generators are security-sensitive
python:S3776|Cognitive Complexity of functions should not be too high
pythonsecurity:S8705|Argument injection
pythonsecurity:S8707|Agentic workflows should not be vulnerable to path injection attacks
shell:S5332|Using clear-text protocols is security-sensitive
'

# --- Ant glob -> ERE ----------------------------------------------------------
# Sonar's matcher is Ant-style. Translate to an anchored extended regex:
# `**/` = zero or more directories, `**` = anything, `*` = anything but `/`,
# `?` = one non-`/` char. Placeholders (control chars) keep the passes from
# re-reading each other's output.
ant_to_regex() {
    local g="$1" a=$'\001' b=$'\002'
    printf '%s' "$g" |
        sed -e 's/[][\\.+^$(){}|]/\\&/g' \
            -e "s|\\*\\*/|${a}|g" \
            -e "s|\\*\\*|${b}|g" \
            -e 's|\*|[^/]*|g' \
            -e 's|?|[^/]|g' \
            -e "s|${a}|(.*/)?|g" \
            -e "s|${b}|.*|g" \
            -e 's|^|^|' -e 's|$|$|'
}

# --- Online helpers (check 5) -------------------------------------------------
# sonar_fetch <fixture file name> <api path?query>. With SONAR_API_FIXTURE_DIR
# set it reads a fixture (self-test: no network); otherwise it calls the API.
# The token goes in through curl's stdin config (`-K -`) so it never appears in
# argv (visible in `ps`) or in any message this script prints. A non-zero return
# means "could not fetch", which the caller treats as fail-open. With a third
# argument `allow404`, an HTTP 404 is returned as a normal body (rules/show
# answers an unknown key with 404 + {"errors":[...]}, which is an answer, not an
# outage); any other non-2xx status still means "could not fetch".
sonar_fetch() {
    local out code
    if [[ -n "${SONAR_API_FIXTURE_DIR:-}" ]]; then
        [[ -f "$SONAR_API_FIXTURE_DIR/$1" ]] || return 1
        cat "$SONAR_API_FIXTURE_DIR/$1"
        return 0
    fi
    if [[ "${3:-}" != "allow404" ]]; then
        printf 'user = "%s:"\n' "$SONAR_TOKEN" |
            curl --silent --fail --max-time 30 -K - "${SONAR_HOST_URL:-https://sonarcloud.io}/$2"
        return
    fi
    out="$(printf 'user = "%s:"\n' "$SONAR_TOKEN" |
        curl --silent --max-time 30 --write-out '\n%{http_code}' -K - "${SONAR_HOST_URL:-https://sonarcloud.io}/$2")" || return 1
    code="${out##*$'\n'}"
    [[ "$code" == 2?? || "$code" == 404 ]] || return 1
    printf '%s\n' "${out%$'\n'*}"
}

# Fail-open skip: say so loudly (a silent skip would look like a pass), exit 0.
online_skip() {
    echo "! sonar online check SKIPPED (fail open, not an error): $1"
    echo "    The offline checks above still ran. Only the quality-profile check was skipped."
}

# Check 5. Sets the global `fail` when a rule key is not active in any profile.
run_online_check() {
    local project org repos prof_json pkeys pk page resp total keys active="" id rkey n show
    command -v jq >/dev/null 2>&1 || { online_skip "jq is not installed"; return 0; }
    if [[ -z "${SONAR_API_FIXTURE_DIR:-}" ]]; then
        command -v curl >/dev/null 2>&1 || { online_skip "curl is not installed"; return 0; }
        [[ -n "${SONAR_TOKEN:-}" ]] || { online_skip "SONAR_TOKEN is not set (expected outside the nightly schedule)"; return 0; }
    fi
    project="$(sed -n 's/^sonar\.projectKey=//p' "$PROPS" | head -n 1)"
    org="$(sed -n 's/^sonar\.organization=//p' "$PROPS" | head -n 1)"
    # Values go straight into a URL; refuse anything that is not a plain key
    # rather than encode it (the real ones are `visiban_visiban` / `visiban`).
    if ! [[ "$project" =~ ^[A-Za-z0-9_.:-]+$ && "$org" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
        online_skip "sonar.projectKey / sonar.organization missing or unusual in $PROPS"
        return 0
    fi
    # Rule repositories to ask for (`python`, `pythonsecurity`, ...): narrows each
    # profile query to the repos we care about so one page usually suffices.
    repos="$(grep -E '^sonar\.issue\.ignore\.multicriteria\.[A-Za-z0-9_]+\.ruleKey=' "$PROPS" |
        sed -E 's/^[^=]*=([^:]*):.*/\1/' | sort -u | paste -sd, -)"
    [[ "$repos" =~ ^[A-Za-z0-9_,.-]+$ ]] || { online_skip "could not derive rule repositories from $PROPS"; return 0; }

    prof_json="$(sonar_fetch qualityprofiles.json "api/qualityprofiles/search?project=${project}&organization=${org}")" ||
        { online_skip "quality-profile request failed (network, auth or API error)"; return 0; }
    pkeys="$(jq -r '.profiles[].key' <<<"$prof_json" 2>/dev/null)" ||
        { online_skip "quality-profile response was not parseable"; return 0; }
    [[ -n "$pkeys" ]] || { online_skip "the project reports no quality profiles"; return 0; }

    # A rule is "active" if ANY of the project's profiles activates it: the key's
    # repo implies a language, and the project has one profile per language.
    while IFS= read -r pk; do
        [[ "$pk" =~ ^[A-Za-z0-9_-]+$ ]] || { online_skip "unexpected profile key in the API response"; return 0; }
        page=1
        while :; do
            resp="$(sonar_fetch "rules-${pk}-p${page}.json" "api/rules/search?qprofile=${pk}&activation=true&repositories=${repos}&organization=${org}&ps=500&p=${page}")" ||
                { online_skip "rule request for a quality profile failed"; return 0; }
            keys="$(jq -r '.rules[].key' <<<"$resp" 2>/dev/null)" ||
                { online_skip "rule response was not parseable"; return 0; }
            total="$(jq -r '.total' <<<"$resp" 2>/dev/null)" || total=""
            [[ "$total" =~ ^[0-9]+$ ]] || { online_skip "rule response had no numeric total"; return 0; }
            active+="${keys}"$'\n'
            (( page * 500 >= total )) && break
            page=$((page + 1))
        done
    done <<<"$pkeys"

    # No active rules at all (e.g. the repositories= filter matched nothing) is
    # an unusable answer, not proof every key is inactive: fail open.
    [[ -n "${active//[$'\n']/}" ]] || { online_skip "no active rules returned"; return 0; }

    n=0
    while IFS= read -r line; do
        [[ "$line" =~ ^sonar\.issue\.ignore\.multicriteria\.([A-Za-z0-9_]+)\.ruleKey=(.*)$ ]] || continue
        id="${BASH_REMATCH[1]}"; rkey="${BASH_REMATCH[2]}"
        n=$((n + 1))
        grep -qxF -- "$rkey" <<<"$active" && continue
        # Not in the bulk list: confirm against rules/show before failing.
        if ! [[ "$rkey" =~ ^[A-Za-z0-9_]+:[A-Za-z0-9_]+$ ]] ||
            ! show="$(sonar_fetch "show-${rkey/:/_}.json" "api/rules/show?key=${rkey}&organization=${org}&actives=true" allow404)" ||
            ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$show"; then
            echo "! $id: could not confirm ruleKey '$rkey' via rules/show (fail open, not an error)"
            continue
        fi
        if [[ "$(jq -r '.rule.key // empty' <<<"$show")" != "$rkey" ]]; then
            echo "x $id: ruleKey '$rkey' does not exist in SonarCloud"
            echo "    The key was never valid or the rule was removed/renamed, so this"
            echo "    suppression excuses nothing. Delete the criterion, or fix the key (and"
            echo "    its RULE_TITLES row) to the rule's current key."
            fail=1
        elif ! jq -r '.actives[]?.qProfile' <<<"$show" | grep -qxF -f <(printf '%s\n' "$pkeys"); then
            echo "x $id: ruleKey '$rkey' is not active in any quality profile of $project"
            echo "    The rule was deactivated in the SonarCloud profile, so this"
            echo "    suppression excuses nothing. Delete the criterion, or fix the key (and"
            echo "    its RULE_TITLES row) to the rule's current key."
            fail=1
        fi
    done <"$PROPS"
    [[ "$fail" -eq 0 ]] && echo "ok sonar online: $n rule keys active in the quality profile"
    return 0
}

# --- Self-test ---------------------------------------------------------------
# A gate nobody has seen fail is a gate nobody knows works. Each fault case
# asserts BOTH a non-zero exit AND the specific message of the check that is
# supposed to fire, so disabling any one check turns its case red.
if [[ "${1:-}" == "--self-test" ]]; then
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    pass=0
    idx_re='^sonar\.issue\.ignore\.multicriteria='

    # run_case <name> <expected message> <new index ids, comma-joined or ""> <extra lines>
    run_case() {
        local name="$1" want="$2" ids="$3" extra="$4" out
        # Anchor on the real index line, not the first "multicriteria=" in the
        # file (the policy header comment mentions it too).
        sed -E "s/(${idx_re})/\1${ids:+${ids},}/" sonar-project.properties >"$tmp/$name.properties"
        [[ -n "$extra" ]] && printf '%s\n' "$extra" >>"$tmp/$name.properties"
        if out="$(bash "$0" "$tmp/$name.properties" 2>&1)"; then
            echo "x self-test '$name': expected failure, got success"
            pass=1
        elif ! grep -qF -- "$want" <<<"$out"; then
            echo "x self-test '$name': failed, but not with '$want'"
            pass=1
        else
            echo "ok self-test '$name': rejected by the intended check"
        fi
    }

    mc='sonar.issue.ignore.multicriteria'
    run_case "dead-glob" "matches no tracked file" "zz" "$mc.zz.ruleKey=typescript:S1
$mc.zz.resourceKey=frontend/src/nope/gone.ts"
    run_case "ant-dead-glob" "matches no tracked file" "zz" "$mc.zz.ruleKey=typescript:S1
$mc.zz.resourceKey=**/est/**"
    # `Makefil[e]` read as a character class would match the tracked Makefile;
    # read literally (as Ant does) it matches nothing, so it must be reported dead.
    run_case "bracket-literal" "matches no tracked file" "zz" "$mc.zz.ruleKey=typescript:S1
$mc.zz.resourceKey=Makefil[e]"
    run_case "drift-literal" "also contains" "zz" "$mc.zz.ruleKey=typescript:S1
$mc.zz.resourceKey=frontend/src/components/Board/*.ts"
    run_case "drift-doublestar-prefix" "also contains" "zz" "$mc.zz.ruleKey=typescript:S1
$mc.zz.resourceKey=**/components/Board/*.ts"
    run_case "drift-doublestar-mid" "also contains" "zz" "$mc.zz.ruleKey=typescript:S1
$mc.zz.resourceKey=frontend/src/**/*.ts"
    run_case "unlisted-criterion" "missing from the multicriteria index" "" "$mc.zz.ruleKey=typescript:S1
$mc.zz.resourceKey=Makefile"
    run_case "orphan-resourceKey" "missing from the multicriteria index" "" "$mc.zz.resourceKey=Makefile"
    run_case "missing-resourceKey" "has no .resourceKey" "zz" "$mc.zz.ruleKey=typescript:S1"
    # Check 4: an unregistered key, and a key contradicting the comment above it.
    run_case "unknown-rule-key" "is not in the RULE_TITLES table" "zz" "$mc.zz.ruleKey=javascript:S6325
$mc.zz.resourceKey=Makefile"
    run_case "comment-key-mismatch" "comment above cites" "zz" "# S2871: .sort() without localeCompare
$mc.zz.ruleKey=javascript:S4036
$mc.zz.resourceKey=Makefile"
    run_case "ghost-index-id" "has no .ruleKey" "zz" ""
    # Check 4b (#1425): a criterion must name its rule in its own comment block.
    # No S-number and no title -> "names no rule"; a wrong S-number is caught by
    # the mismatch case above.
    run_case "rule-not-named" "names no rule" "zz" "# a rationale that never says which rule this is
$mc.zz.ruleKey=javascript:S4036
$mc.zz.resourceKey=Makefile"
    run_case "wrong-rule-named" "comment above cites" "zz" "# S1192: duplicated literals
$mc.zz.ruleKey=python:S3776
$mc.zz.resourceKey=Makefile"
    # ...and the title is an accepted way to name it (positive case).
    cp sonar-project.properties "$tmp/title-named.properties"
    sed -i.bak -E "s/(${idx_re})/\1zz,/" "$tmp/title-named.properties"
    printf '%s\n' "# Cognitive Complexity of functions should not be too high, excused here" \
        "$mc.zz.ruleKey=python:S3776" "$mc.zz.resourceKey=Makefile" >>"$tmp/title-named.properties"
    if bash "$0" "$tmp/title-named.properties" >/dev/null 2>&1; then
        echo "ok self-test 'title-named': a RULE_TITLES title names the rule"
    else
        echo "x self-test 'title-named': a comment quoting the rule title should satisfy check 4b"
        pass=1
    fi

    # Check 5 (#1425): online mode, driven by fixtures (no network, no token).
    # Build a fixture dir whose one profile activates every key in the real file.
    fx="$tmp/fx"
    mkdir -p "$fx"
    all_keys="$(grep -E "^${mc//./\\.}\.[A-Za-z0-9_]+\.ruleKey=" sonar-project.properties | sed 's/^[^=]*=//' | sort -u)"
    printf '{"profiles":[{"key":"P1","name":"Sonar way","language":"py"}]}\n' >"$fx/qualityprofiles.json"
    rules_json() { # rules_json <keys, newline-separated> -> a one-page rules/search response
        printf '%s\n' "$1" | jq -Rn '[inputs | select(length > 0) | {key: .}] | {total: length, p: 1, ps: 500, rules: .}'
    }
    # run_online <name> <want exit 0|1> <expected message> [env assignments...]
    run_online() {
        local name="$1" want_rc="$2" want="$3" out rc=0
        shift 3
        out="$(env "$@" bash "$0" --online 2>&1)" || rc=$?
        if [[ "$rc" -ne "$want_rc" ]]; then
            echo "x self-test '$name': expected exit $want_rc, got $rc"
            pass=1
        elif ! grep -qF -- "$want" <<<"$out"; then
            echo "x self-test '$name': exit ok but missing '$want'"
            pass=1
        elif grep -qF -- "s3cr3t-token" <<<"$out"; then
            echo "x self-test '$name': the token leaked into the output"
            pass=1
        else
            echo "ok self-test '$name': behaved as intended"
        fi
    }
    rules_json "$all_keys" >"$fx/rules-P1-p1.json"
    run_online "online-all-active" 0 "ok sonar online" "SONAR_API_FIXTURE_DIR=$fx"
    rules_json "$(grep -vxF 'python:S1192' <<<"$all_keys")" >"$fx/rules-P1-p1.json"
    # Missing from the bulk list, rules/show confirms it active in P1 -> pass
    # (the pythonsecurity:S8705 search-index gap, 2026-10-05).
    printf '{"rule":{"key":"python:S1192"},"actives":[{"qProfile":"P1"}]}\n' >"$fx/show-python_S1192.json"
    run_online "online-search-gap-confirmed" 0 "ok sonar online" "SONAR_API_FIXTURE_DIR=$fx"
    # ...active only in some other org's profile -> inactive here.
    printf '{"rule":{"key":"python:S1192"},"actives":[{"qProfile":"OTHER"}]}\n' >"$fx/show-python_S1192.json"
    run_online "online-rule-inactive" 1 "is not active in any quality profile" "SONAR_API_FIXTURE_DIR=$fx"
    # ...404 "Rule not found" -> the key does not exist.
    printf '{"errors":[{"msg":"Rule not found: python:S1192"}]}\n' >"$fx/show-python_S1192.json"
    run_online "online-rule-not-found" 1 "does not exist in SonarCloud" "SONAR_API_FIXTURE_DIR=$fx"
    # ...rules/show unreachable -> fail open for that key.
    rm "$fx/show-python_S1192.json"
    run_online "online-show-unreachable" 0 "could not confirm ruleKey" "SONAR_API_FIXTURE_DIR=$fx"
    # Fail open: every infra failure must exit 0 and say it skipped.
    run_online "online-no-token" 0 "SKIPPED (fail open" -u SONAR_TOKEN -u SONAR_API_FIXTURE_DIR
    mkdir -p "$tmp/fx-empty"
    run_online "online-api-error" 0 "SKIPPED (fail open" "SONAR_API_FIXTURE_DIR=$tmp/fx-empty"
    mkdir -p "$tmp/fx-garbage"
    printf 'not json at all\n' >"$tmp/fx-garbage/qualityprofiles.json"
    mkdir -p "$tmp/fx-zero"
    cp "$fx/qualityprofiles.json" "$tmp/fx-zero/"
    printf '{"total":0,"p":1,"ps":500,"rules":[]}\n' >"$tmp/fx-zero/rules-P1-p1.json"
    run_online "online-zero-rules" 0 "no active rules returned" "SONAR_API_FIXTURE_DIR=$tmp/fx-zero"
    run_online "online-unparseable" 0 "SKIPPED (fail open" "SONAR_API_FIXTURE_DIR=$tmp/fx-garbage"
    # Token set but unreachable host: curl fails -> skip, and the token stays out of the output.
    run_online "online-unreachable-token-hidden" 0 "SKIPPED (fail open" -u SONAR_API_FIXTURE_DIR \
        SONAR_TOKEN=s3cr3t-token SONAR_HOST_URL=http://127.0.0.1:9

    if bash "$0" >/dev/null 2>&1; then
        echo "ok self-test 'clean-tree': correctly accepted"
    else
        echo "x self-test 'clean-tree': the real file should pass"
        pass=1
    fi

    [[ "$pass" -eq 0 ]] && echo "" && echo "ok self-test passed"
    exit "$pass"
fi

ONLINE=0
PROPS=""
for arg in "$@"; do
    case "$arg" in
        --online) ONLINE=1 ;;
        *) PROPS="$arg" ;;
    esac
done
PROPS="${PROPS:-sonar-project.properties}"
[[ -f "$PROPS" ]] || {
    echo "check-sonar-exclusions: $PROPS not found" >&2
    exit 1
}

# Tracked files only: the scanner analyses what is committed. Portable read
# loop (macOS ships bash 3.2, no mapfile). TRACKED_NL is the same list for grep.
TRACKED=()
while IFS= read -r f; do TRACKED+=("$f"); done < <(git ls-files)
TRACKED_NL="$(printf '%s\n' "${TRACKED[@]}")"

fail=0

# --- Parse ------------------------------------------------------------------
index_line="$(grep -E '^sonar\.issue\.ignore\.multicriteria=' "$PROPS" || true)"
if [[ -z "$index_line" ]]; then
    echo "check-sonar-exclusions: no multicriteria index line found" >&2
    exit 1
fi
IFS=',' read -r -a INDEXED <<<"${index_line#*=}"

# Every id that has ANY definition line (.ruleKey or .resourceKey): an orphan
# .resourceKey must not slip past check 3.
DEFINED=()
while IFS= read -r id; do DEFINED+=("$id"); done < <(
    grep -oE '^sonar\.issue\.ignore\.multicriteria\.[A-Za-z0-9_]+\.(ruleKey|resourceKey)' "$PROPS" |
        sed -E 's/^sonar\.issue\.ignore\.multicriteria\.([A-Za-z0-9_]+)\..*$/\1/' | sort -u
)

RES_LINES="$(grep -E '^sonar\.issue\.ignore\.multicriteria\.[A-Za-z0-9_]+\.resourceKey=' "$PROPS" || true)"

# --- 1. every resourceKey glob still matches a tracked file -----------------
while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    id="$(sed -E 's/^sonar\.issue\.ignore\.multicriteria\.([A-Za-z0-9_]+)\.resourceKey=.*/\1/' <<<"$line")"
    glob="${line#*=}"
    if ! grep -Eq "$(ant_to_regex "$glob")" <<<"$TRACKED_NL"; then
        echo "x $id: resourceKey matches no tracked file"
        echo "    glob: $glob"
        echo "    This criterion is dead or has drifted - the code it excused was"
        echo "    renamed, moved, or deleted. Delete it, or repoint it at the new"
        echo "    path. Do NOT widen the glob to make this pass."
        fail=1
    fi
done <<<"$RES_LINES"

# --- 1b. extension-narrow globs in mixed-extension directories ---------------
# Check 1 only catches a glob that matches NOTHING. TruePPM #2517 was a partial
# drift: `activity/*.ts` kept matching one file, so it stayed "live" while
# silently dropping another once it became .tsx. What IS detectable is the
# shape: a glob ending `*.ts` (or `*.js`) that covers a directory also holding
# `.tsx`/`.jsx`. Take the glob, swap the extension for its JSX sibling, and see
# whether it matches anything tracked - this handles `**` spellings for free
# because it reuses the Ant matcher on the whole glob.
while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    id="$(sed -E 's/^sonar\.issue\.ignore\.multicriteria\.([A-Za-z0-9_]+)\.resourceKey=.*/\1/' <<<"$line")"
    glob="${line#*=}"
    case "$glob" in
        *'*.ts') sibling="${glob}x"; ext="ts" ;;
        *'*.js') sibling="${glob}x"; ext="js" ;;
        *) continue ;;
    esac
    hit="$(grep -E "$(ant_to_regex "$sibling")" <<<"$TRACKED_NL" | head -n 1 || true)"
    if [[ -n "$hit" ]]; then
        echo "x $id: '*.$ext' glob in a directory that also contains .${ext}x files"
        echo "    glob: $glob"
        echo "    e.g.: $hit"
        echo "    This under-matches silently: a file here that grows JSX gets renamed"
        echo "    to .${ext}x and drops out of the glob, with no job going red (the"
        echo "    TruePPM #2517 failure). List the files explicitly, or widen to"
        echo "    '*.${ext}*' if the wider set is what you mean."
        fail=1
    fi
done <<<"$RES_LINES"

# --- 2. every indexed criterion is fully defined ----------------------------
for id in "${INDEXED[@]}"; do
    id="${id// /}"
    [[ -z "$id" ]] && continue
    for key in ruleKey resourceKey; do
        if ! grep -qE "^sonar\.issue\.ignore\.multicriteria\.${id}\.${key}=" "$PROPS"; then
            echo "x $id: listed in the multicriteria index but has no .$key"
            fail=1
        fi
    done
done

# --- 3. every defined criterion is indexed ----------------------------------
# Sonar only reads criteria named in the index line, so a defined-but-unlisted
# one suppresses nothing while looking like it does.
for id in "${DEFINED[@]}"; do
    listed=0
    for indexed in "${INDEXED[@]}"; do
        [[ "${indexed// /}" == "$id" ]] && listed=1 && break
    done
    if [[ "$listed" -eq 0 ]]; then
        echo "x $id: defined but missing from the multicriteria index - it is inert"
        fail=1
    fi
done

# --- 4. rule key is registered, and the comment above it names it ------------
# `pending` collects the S-numbers cited in comment lines since the previous
# criterion and `ctext` the comment text itself. Since #1425 a criterion must
# name its OWN rule in that block - an S-number equal to the key's, or the
# RULE_TITLES title - so a sibling under a shared header cannot lean on its
# predecessor's comment (the copy-pasted-wrong-key gap). Citing S-numbers that
# exclude the key's own is the stronger signal and keeps its own message (#1407).
pending=""
ctext=""
while IFS= read -r line; do
    if [[ "$line" == \#* ]]; then
        pending+=" $(grep -oE 'S[0-9]{3,5}' <<<"$line" | tr '\n' ' ' || true)"
        ctext+="${line}"$'\n'
    elif [[ "$line" =~ ^sonar\.issue\.ignore\.multicriteria\.([A-Za-z0-9_]+)\.ruleKey=(.*)$ ]]; then
        id="${BASH_REMATCH[1]}"; rkey="${BASH_REMATCH[2]}"
        title=""
        if ! grep -qxE "$(sed 's/[.]/\\./g' <<<"$rkey")\|.*" <<<"$RULE_TITLES"; then
            echo "x $id: ruleKey '$rkey' is not in the RULE_TITLES table"
            echo "    Look up the rule on SonarCloud, confirm its title matches what the"
            echo "    comment claims, then register it in scripts/check-sonar-exclusions.sh."
            fail=1
        else
            title="$(grep -xE "$(sed 's/[.]/\\./g' <<<"$rkey")\|.*" <<<"$RULE_TITLES" | head -n 1 | cut -d'|' -f2-)"
        fi
        num="${rkey##*:}"
        if [[ -n "${pending// /}" ]] && ! grep -qw "$num" <<<"$pending"; then
            echo "x $id: ruleKey '$rkey' but the comment above cites:${pending}"
            echo "    The key does not mean what its comment says (#1407). Fix the key or the comment."
            fail=1
        elif ! grep -qw "$num" <<<"$pending" && { [[ -z "$title" ]] || ! grep -qiF -- "$title" <<<"$ctext"; }; then
            echo "x $id: the comment above ruleKey '$rkey' names no rule (#1425)"
            echo "    Each criterion's own comment block must say which rule it silences: cite"
            echo "    $num, or quote the rule title${title:+ ($title)}. A criterion that"
            echo "    shares a header with its sibling needs its own naming line."
            fail=1
        fi
        pending=""
        ctext=""
    fi
done <"$PROPS"

# --- 5. online: every rule key is active in the quality profile (#1425) ------
if [[ "$ONLINE" -eq 1 ]]; then
    run_online_check
fi

if [[ "$fail" -ne 0 ]]; then
    echo ""
    echo "Sonar exclusion integrity check FAILED - see $PROPS"
    exit 1
fi

echo "ok sonar exclusions: ${#INDEXED[@]} criteria, all live and consistent"
