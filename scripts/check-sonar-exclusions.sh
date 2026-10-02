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
#   1. every `<id>.resourceKey` glob matches >= 1 tracked file
#   1b. no glob is pinned to `*.ts`/`*.js` in a directory that also holds
#      `.tsx`/`.jsx` files (the #2517 drift shape)
#   2. every criterion in the `multicriteria=` index has both a `.ruleKey` and a
#      `.resourceKey` defined
#   3. every defined criterion appears in the `multicriteria=` index - a
#      criterion defined but unlisted is silently inert, the same bug from the
#      other direction
#
# Deliberately NOT checked: whether the rule still fires. That needs a full
# SonarCloud scan and a token; this runs offline in milliseconds. Also not
# detectable here: a pattern that still matches its original file while growing
# a SECOND home elsewhere. The durable fix for that is on the code side - keep a
# suppressed pattern in ONE place so a copy has nowhere to hide.
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

# --- Self-test ---------------------------------------------------------------
# A gate nobody has seen fail is a gate nobody knows works. Mirrors the
# `check-todo-grep.sh --self-test` convention: inject each fault this script is
# supposed to catch and assert a non-zero exit.
if [[ "${1:-}" == "--self-test" ]]; then
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
        pass=0

    run_case() {
        local name="$1" body="$2"
        printf '%s\n' "$body" >"$tmp/$name.properties"
        if bash "$0" "$tmp/$name.properties" >/dev/null 2>&1; then
            echo "✖ self-test '$name': expected failure, got success"
            pass=1
        else
            echo "✓ self-test '$name': correctly rejected"
        fi
    }

    base="$(cat sonar-project.properties)"
    run_case "dead-glob" "${base/multicriteria=/multicriteria=zzdead,}
sonar.issue.ignore.multicriteria.zzdead.ruleKey=typescript:S1
sonar.issue.ignore.multicriteria.zzdead.resourceKey=frontend/src/nope/gone.ts"

    run_case "drift-prone-glob" "${base/multicriteria=/multicriteria=zzdrift,}
sonar.issue.ignore.multicriteria.zzdrift.ruleKey=typescript:S1
sonar.issue.ignore.multicriteria.zzdrift.resourceKey=frontend/src/components/Board/*.ts"

    run_case "unlisted-criterion" "$base
sonar.issue.ignore.multicriteria.zzunlisted.ruleKey=typescript:S1
sonar.issue.ignore.multicriteria.zzunlisted.resourceKey=Makefile"

    run_case "missing-resourceKey" "${base/multicriteria=/multicriteria=zzpartial,}
sonar.issue.ignore.multicriteria.zzpartial.ruleKey=typescript:S1"

    if bash "$0" >/dev/null 2>&1; then
        echo "✓ self-test 'clean-tree': correctly accepted"
    else
        echo "✖ self-test 'clean-tree': the real file should pass"
        pass=1
    fi

    [[ "$pass" -eq 0 ]] && echo "" && echo "✓ self-test passed"
    exit "$pass"
fi

PROPS="${1:-sonar-project.properties}"
[[ -f "$PROPS" ]] || {
    echo "check-sonar-exclusions: $PROPS not found" >&2
    exit 1
}

# Tracked files only. A glob matching solely untracked/generated output is dead
# for Sonar's purposes too — the scanner analyses what is committed.
#
# `mapfile` is bash 4+; macOS ships bash 3.2 and developers run this locally, so
# every array is built with a portable read loop instead.
TRACKED=()
while IFS= read -r f; do TRACKED+=("$f"); done < <(git ls-files)

fail=0

# --- Parse ------------------------------------------------------------------
# The index line, comma-separated. Criteria are declared once here and defined
# as `<id>.ruleKey` / `<id>.resourceKey` further down the file.
index_line="$(grep -E '^sonar\.issue\.ignore\.multicriteria=' "$PROPS" || true)"
if [[ -z "$index_line" ]]; then
    echo "check-sonar-exclusions: no multicriteria index line found" >&2
    exit 1
fi
IFS=',' read -r -a INDEXED <<<"${index_line#*=}"

DEFINED_RULE=()
while IFS= read -r id; do DEFINED_RULE+=("$id"); done < <(
    grep -oE '^sonar\.issue\.ignore\.multicriteria\.[A-Za-z0-9_]+\.ruleKey' "$PROPS" |
        sed -E 's/^sonar\.issue\.ignore\.multicriteria\.([A-Za-z0-9_]+)\.ruleKey$/\1/' | sort -u
)

# --- 1. every resourceKey glob still matches a tracked file -----------------
# Sonar's matcher is Ant-style: `**` spans directories, `*` and `?` do not. Bash
# extglob gets close enough for this check — translate `**/` to a `*` that may
# span `/`, which is what `[[ $path == $glob ]]` gives us once globstar-ish
# patterns are flattened. Anything ambiguous errs toward "matched" so this gate
# never blocks a push on its own approximation.
while IFS= read -r line; do
    id="$(sed -E 's/^sonar\.issue\.ignore\.multicriteria\.([A-Za-z0-9_]+)\.resourceKey=.*/\1/' <<<"$line")"
    glob="${line#*=}"

    # Flatten Ant `**` into a bash `*`; bash `*` already crosses `/` inside [[ ]].
    pattern="${glob//\*\*\//*}"
    pattern="${pattern//\*\*/*}"

    matched=0
    for f in "${TRACKED[@]}"; do
        # shellcheck disable=SC2053  # intentional glob match, not string compare
        if [[ "$f" == $pattern ]]; then
            matched=1
            break
        fi
    done

    if [[ "$matched" -eq 0 ]]; then
        echo "✖ $id: resourceKey matches no tracked file"
        echo "    glob: $glob"
        echo "    This criterion is dead or has drifted — the code it excused was"
        echo "    renamed, moved, or deleted. Delete it, or repoint it at the new"
        echo "    path. Do NOT widen the glob to make this pass."
        fail=1
    fi
done < <(grep -E '^sonar\.issue\.ignore\.multicriteria\.[A-Za-z0-9_]+\.resourceKey=' "$PROPS")

# --- 1b. extension-narrow globs in mixed-extension directories ---------------
# Check 1 only catches a glob that matches NOTHING. #2517 was a *partial* drift:
# `activity/*.ts` kept matching one file, so it stayed "live" while
# silently dropping another once it became .tsx. A dead-glob check
# cannot see that, and no offline check can tell which findings a rule would
# have raised.
#
# What IS detectable is the shape that makes the drift possible: a glob pinned to
# `*.ts` (or `*.js`) in a directory that ALSO holds `.tsx`/`.jsx`. In such a
# directory a file is one JSX addition away from falling out of the glob, and
# nothing about that rename looks related to Sonar. That directory already held .tsx
# files when the glob was written, so this flags it at authoring time.
#
# Fix by listing the files explicitly or widening to
# `*.ts*` — but only once you have confirmed the wider set is what you meant.
while IFS= read -r line; do
    id="$(sed -E 's/^sonar\.issue\.ignore\.multicriteria\.([A-Za-z0-9_]+)\.resourceKey=.*/\1/' <<<"$line")"
    glob="${line#*=}"

    case "$glob" in
        *'*.ts' | *'*.js') ;;
        *) continue ;;
    esac

    dir="${glob%/*}"
    sibling_ext="tsx"
    [[ "$glob" == *'*.js' ]] && sibling_ext="jsx"

    for f in "${TRACKED[@]}"; do
        if [[ "$f" == "$dir"/*".$sibling_ext" ]]; then
            echo "✖ $id: '*.${sibling_ext%x}' glob in a directory that also contains .$sibling_ext files"
            echo "    glob: $glob"
            echo "    e.g.: $f"
            echo "    This under-matches silently: a file in this directory that grows"
            echo "    JSX gets renamed to .$sibling_ext and drops out of the glob, with no"
            echo "    job going red. That is the TruePPM #2517 failure. List the files"
            echo "    explicitly, or widen to '*.ts*' if the wider set is what you mean."
            fail=1
            break
        fi
    done
done < <(grep -E '^sonar\.issue\.ignore\.multicriteria\.[A-Za-z0-9_]+\.resourceKey=' "$PROPS")

# --- 2. every indexed criterion is fully defined ----------------------------
for id in "${INDEXED[@]}"; do
    id="${id// /}"
    [[ -z "$id" ]] && continue
    for key in ruleKey resourceKey; do
        if ! grep -qE "^sonar\.issue\.ignore\.multicriteria\.${id}\.${key}=" "$PROPS"; then
            echo "✖ $id: listed in the multicriteria index but has no .$key"
            fail=1
        fi
    done
done

# --- 3. every defined criterion is indexed ----------------------------------
# Sonar only reads criteria named in the index line, so a defined-but-unlisted
# one suppresses nothing while looking like it does.
for id in "${DEFINED_RULE[@]}"; do
    listed=0
    for indexed in "${INDEXED[@]}"; do
        [[ "${indexed// /}" == "$id" ]] && listed=1 && break
    done
    if [[ "$listed" -eq 0 ]]; then
        echo "✖ $id: defined but missing from the multicriteria index — it is inert"
        fail=1
    fi
done

if [[ "$fail" -ne 0 ]]; then
    echo ""
    echo "Sonar exclusion integrity check FAILED — see $PROPS"
    exit 1
fi

echo "✓ sonar exclusions: ${#INDEXED[@]} criteria, all live and consistent"
