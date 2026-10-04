#!/usr/bin/env python3
"""Resolve the schemathesis seed for backend-schema-fuzz (#1207).

Precedence: explicit FUZZ_SEED variable, then a `Fuzz-Seed: <n>` trailer on the
MR head commit (CI_COMMIT_MESSAGE, merge request pipelines only), then a fresh
random seed.

Why a commit trailer: MR pipelines cannot take pipeline variables (workflow:rules
only admits merge_request_event/default-branch/tag pipelines, and the MR pipeline
API ignores `variables`), so a developer replays a seed by pushing an empty commit
carrying the trailer. No API token, extra job, or workflow-rules change needed.

Why strict validation: the value comes from a commit message, and the seed is
passed to a shell command and (by fuzz_deep_file_issue.py) into an issue body, so
anything but a plain non-negative integer is rejected rather than sanitized.

stdout: the seed only. stderr: where it came from. Exit 2 on an invalid value.

Usage:
  scripts/resolve_fuzz_seed.py            # reads FUZZ_SEED, CI_COMMIT_MESSAGE,
                                          # CI_PIPELINE_SOURCE from the environment
  scripts/resolve_fuzz_seed.py --self-test
"""
import os
import re
import secrets
import sys

# ASCII digits only (str.isdigit accepts unicode digits), capped at 64 bits to
# match secrets.randbits(64) and keep the value a sane argument.
_SEED_RE = re.compile(r"[0-9]{1,20}")
_TRAILER_RE = re.compile(r"^Fuzz-Seed:[ \t]*(.*?)[ \t]*$", re.IGNORECASE | re.MULTILINE)
_MAX = 2**64 - 1


class InvalidSeed(ValueError):
    pass


def _validate(value, origin):
    if not _SEED_RE.fullmatch(value) or int(value) > _MAX:
        raise InvalidSeed(f"{origin} must be a plain non-negative integer below 2**64")
    return str(int(value))


def resolve(env, rand=lambda: secrets.randbits(64)):
    """Return (seed, source) for the given environment mapping."""
    explicit = env.get("FUZZ_SEED", "")
    if explicit.strip():
        return _validate(explicit.strip(), "FUZZ_SEED variable"), "FUZZ_SEED variable"
    if env.get("CI_PIPELINE_SOURCE") == "merge_request_event":
        matches = _TRAILER_RE.findall(env.get("CI_COMMIT_MESSAGE", ""))
        if matches:
            # Last one wins so a later empty commit can override an earlier pin.
            return _validate(matches[-1], "Fuzz-Seed trailer"), "Fuzz-Seed commit trailer"
    return str(rand()), "random"


def _self_test():
    mr = {"CI_PIPELINE_SOURCE": "merge_request_event"}
    ok = True

    def check(name, cond):
        nonlocal ok
        print(f"{'ok  ' if cond else 'FAIL'} {name}", file=sys.stderr)
        ok = ok and cond

    def rejects(env):
        try:
            resolve(env)
        except InvalidSeed:
            return True
        return False

    msg = "ci: pin seed\n\nFuzz-Seed: 12345\n"
    check("trailer parsed on MR pipeline", resolve({**mr, "CI_COMMIT_MESSAGE": msg}, lambda: 9) == ("12345", "Fuzz-Seed commit trailer"))
    check("trailer is case-insensitive", resolve({**mr, "CI_COMMIT_MESSAGE": "x\n\nfuzz-seed:7"})[0] == "7")
    check("last trailer wins", resolve({**mr, "CI_COMMIT_MESSAGE": "Fuzz-Seed: 1\nFuzz-Seed: 2"})[0] == "2")
    check("explicit variable beats trailer", resolve({**mr, "FUZZ_SEED": "42", "CI_COMMIT_MESSAGE": msg}) == ("42", "FUZZ_SEED variable"))
    check("no trailer falls back to random", resolve({**mr, "CI_COMMIT_MESSAGE": "plain"}, lambda: 9) == ("9", "random"))
    check("trailer ignored off MR pipelines", resolve({"CI_PIPELINE_SOURCE": "push", "CI_COMMIT_MESSAGE": msg}, lambda: 9) == ("9", "random"))
    check("trailer mid-line is not a trailer", resolve({**mr, "CI_COMMIT_MESSAGE": "see Fuzz-Seed: 5"}, lambda: 9)[1] == "random")
    check("non-integer trailer rejected", rejects({**mr, "CI_COMMIT_MESSAGE": "Fuzz-Seed: abc"}))
    check("shell metacharacters rejected", rejects({**mr, "CI_COMMIT_MESSAGE": "Fuzz-Seed: 1; rm -rf /"}))
    check("negative rejected", rejects({**mr, "CI_COMMIT_MESSAGE": "Fuzz-Seed: -1"}))
    check("empty trailer rejected", rejects({**mr, "CI_COMMIT_MESSAGE": "Fuzz-Seed:"}))
    check("unicode digits rejected", rejects({**mr, "CI_COMMIT_MESSAGE": "Fuzz-Seed: ١٢"}))
    check("over 64 bits rejected", rejects({**mr, "CI_COMMIT_MESSAGE": f"Fuzz-Seed: {2**64}"}))
    check("invalid explicit variable rejected", rejects({"FUZZ_SEED": "1 2"}))
    check("blank explicit variable ignored", resolve({"FUZZ_SEED": "  "}, lambda: 9)[1] == "random")
    seed, _ = resolve({})
    check("random seed is an integer", _SEED_RE.fullmatch(seed) is not None)
    return 0 if ok else 1


def main(argv):
    if "--self-test" in argv:
        return _self_test()
    try:
        seed, source = resolve(os.environ)
    except InvalidSeed as exc:
        print(f"resolve_fuzz_seed: {exc}", file=sys.stderr)
        return 2
    print(f"resolve_fuzz_seed: seed {seed} from {source}", file=sys.stderr)
    print(seed)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
