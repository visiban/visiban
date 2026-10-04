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
# Deliberately NOT checked: whether the rule still fires. That needs a full
# SonarCloud scan and a token; this runs offline in milliseconds. Also not
# detectable here: a pattern that still matches its original file while growing
# a SECOND home elsewhere. The durable fix for that is on the code side - keep a
# suppressed pattern in ONE place so a copy has nowhere to hide.
#
# Known limits of check 4 (both tracked in #1425):
#   (a) RULE_TITLES proves a human registered the key, not that the rule is
#       active in the SonarCloud quality profile.
#   (b) A criterion whose preceding comment cites no S-number is only
#       table-checked, so a wrong key that is in the table still passes.
#
# Suppression policy lives in the header of sonar-project.properties; see also
# docs/development/suppressions.md.
#
# USAGE
#   check-sonar-exclusions.sh [properties-file]
#   check-sonar-exclusions.sh --self-test   # prove the gate fails when it should
#
# EXIT CODES
#   0  all criteria are live and consistent
#   1  at least one dead glob, drift-prone glob, or index/definition mismatch
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
python:S2589|Boolean expressions should not be gratuitous
python:S3776|Cognitive Complexity of functions should not be too high
pythonsecurity:S8705|Argument injection
secrets:S6437|Secrets should not be hardcoded
shell:S5332|Using clear-text protocols is security-sensitive
yaml:S6437|Secrets should not be hardcoded
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

    if bash "$0" >/dev/null 2>&1; then
        echo "ok self-test 'clean-tree': correctly accepted"
    else
        echo "x self-test 'clean-tree': the real file should pass"
        pass=1
    fi

    [[ "$pass" -eq 0 ]] && echo "" && echo "ok self-test passed"
    exit "$pass"
fi

PROPS="${1:-sonar-project.properties}"
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

# --- 4. rule key is registered and agrees with the comment above it ---------
# `pending` collects the S-numbers cited in comment lines since the previous
# criterion; a criterion that shares a header with its predecessor sees none and
# is only table-checked, which is the intended scope (a header documents the
# first criterion, siblings repeat it).
pending=""
while IFS= read -r line; do
    if [[ "$line" == \#* ]]; then
        pending+=" $(grep -oE 'S[0-9]{3,5}' <<<"$line" | tr '\n' ' ' || true)"
    elif [[ "$line" =~ ^sonar\.issue\.ignore\.multicriteria\.([A-Za-z0-9_]+)\.ruleKey=(.*)$ ]]; then
        id="${BASH_REMATCH[1]}"; rkey="${BASH_REMATCH[2]}"
        if ! grep -qxE "$(sed 's/[.]/\\./g' <<<"$rkey")\|.*" <<<"$RULE_TITLES"; then
            echo "x $id: ruleKey '$rkey' is not in the RULE_TITLES table"
            echo "    Look up the rule on SonarCloud, confirm its title matches what the"
            echo "    comment claims, then register it in scripts/check-sonar-exclusions.sh."
            fail=1
        fi
        num="${rkey##*:}"
        if [[ -n "${pending// /}" ]] && ! grep -qw "$num" <<<"$pending"; then
            echo "x $id: ruleKey '$rkey' but the comment above cites:${pending}"
            echo "    The key does not mean what its comment says (#1407). Fix the key or the comment."
            fail=1
        fi
        pending=""
    fi
done <"$PROPS"

if [[ "$fail" -ne 0 ]]; then
    echo ""
    echo "Sonar exclusion integrity check FAILED - see $PROPS"
    exit 1
fi

echo "ok sonar exclusions: ${#INDEXED[@]} criteria, all live and consistent"
