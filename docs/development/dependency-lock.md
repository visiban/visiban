# Edit requirements.txt, then regenerate the lock

Edit `backend/requirements.txt`, run `scripts/lock-backend-requirements.sh`, and commit the result.

**Why it matters:** Backend images install from `backend/requirements.lock`, a fully resolved, hash-pinned file, not from `backend/requirements.txt`. Pip never runs a package's `setup.py` and rejects any file whose hash is not in the lock.

**Watch out:** Never edit `backend/requirements.lock` by hand.

| File | Role |
|---|---|
| `backend/requirements.txt` | Human-edited source: direct dependencies plus security floors and pins. Edit this one. |
| `backend/requirements-build.in` / `.lock` | Build backend (`setuptools`) for the one sdist-only dependency; see below. |
| `backend/requirements.lock` | Generated. Every direct and transitive package pinned with `sha256` hashes for all platforms (including linux x86_64 and aarch64). Never edit by hand. |

Both `backend/Dockerfile` and `backend/Dockerfile.prod` install with
`--only-binary :all: --require-hashes`. That satisfies SonarCloud `docker:S8541` / `docker:S8544` (#1378).

## Regenerating the lock

Run this after any change to `backend/requirements.txt`:

```bash
pip install --require-hashes -r scripts/uv-requirements.txt   # pinned uv; or brew install uv at the same version
scripts/lock-backend-requirements.sh
git add backend/requirements.txt backend/requirements.lock backend/requirements-build.lock
```

- **How it works:** The script runs `uv pip compile --universal --python-version 3.12 --generate-hashes`, so one lock covers every platform for the images' Python (`python:3.12-slim`).
- **Pinned tool:** uv (Apache-2.0 / MIT, 0.13.4) is pinned in the script, so output is identical locally and in CI.
- **Existing pins stay** unless `requirements.txt` forces a change. To pick up newer transitive versions, delete `backend/requirements.lock` and rerun the script.
- **CI:** the `backend-lock-check` job runs `scripts/lock-backend-requirements.sh --check` (after a network-free `--self-test`) on any MR touching `requirements.txt`, the locks, or the script. It fails when they disagree.

## The dj-rest-auth sdist exception

`dj-rest-auth` is the only dependency that publishes just a source distribution on PyPI (re-checked for 7.1.1). The Dockerfiles pass `--no-binary dj-rest-auth`, which overrides `--only-binary :all:` for that package and builds it into a wheel in the builder stage.

What is and is not verified:

- Verified: every wheel and the `dj-rest-auth` sdist against their `sha256` in `requirements.lock`.
- Verified: the build backend. `backend/requirements-build.lock` hash-pins `setuptools`. The builder installs it with `--only-binary :all: --require-hashes`, then builds with `--no-build-isolation`, so pip fetches no unpinned build requirement. The package's `setup.py` does run, in the builder stage only.
- Not verifiable: the hash of the locally built `dj-rest-auth` wheel. The runtime stage installs `/wheels/*.whl` with `--no-index --no-deps`; the other wheels in it were hash-checked in the builder. Both Dockerfiles use a builder/runtime split, so `setuptools` and the build toolchain never ship in the images.
- CI installs uv from `scripts/uv-requirements.txt` with `--require-hashes`.

If upstream starts publishing a wheel, drop `--no-binary`, `--no-build-isolation` and `requirements-build.*`. If another sdist-only package appears, `uv pip compile --only-binary :all:` fails loudly. Add it to the same `--no-binary` list with a note here, and put its build requirements in `requirements-build.in`.

## pip floor (eMudhra emSign CA incident, #1927)

**Why it matters:** pip older than 26.2.2 always uses its own vendored `certifi`, so the runtime `certifi` floor does not protect pip's TLS to PyPI against the compromised eMudhra emSign intermediates (2026-10-20). `python:3.12-slim` still ships an older pip, so:

- Both Dockerfile builder stages get pip from `backend/requirements-build.lock` (hash-pinned, `pip>=26.2.2` in `requirements-build.in`) in the same step that installs the build backend, and assert the installed version before `pip wheel`.
- CI jobs on `python:3.12-slim` run the `.pip-floor` step (`scripts/ensure-pip.sh`, hash-pinned in `scripts/pip-requirements.txt`) before their first `pip install`. The script fails the job if pip is older than 26.2.2; `backend-lock-check` also runs its `--self-test`.
- uv in `scripts/uv-requirements.txt` is 0.13.4 or newer.

**Yes, but:** The first fetch of the fixed pip is still made by the older pip. It relies on `--require-hashes` rather than TLS: a wrong certificate cannot substitute a file whose sha256 is not in the lock.

All of this is removable once the base image ships pip 26.2.2 or newer. Each location carries a comment saying so. Bump the floor in three places together: `requirements-build.in` (then re-lock), `scripts/pip-requirements.txt`, and `PIP_MIN` in `scripts/ensure-pip.sh`.

## CI test jobs

- **Test jobs** `pip install -r backend/requirements.txt`. They do not build images, so by design they track the latest compatible releases and catch upstream breakage early. Only the shipped images install from the lock.
- **`backend-dep-scan`** audits `requirements.lock` with `pip-audit --require-hashes`. `pip-audit` has no ignore list, so its JSON report is gated through `scripts/pip-audit-gate.py`. That script skips advisories accepted in `backend/osv-scanner.toml` (matched on id or alias, and only until their `ignoreUntil` date).
- **Shared source of truth:** `backend/osv-scanner.toml` is shared with `dep-scan-osv`. The frontend counterpart is `scripts/npm-audit-gate.mjs`.
