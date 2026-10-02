# Backend Dependency Lock

The backend images install from `backend/requirements.lock`, a fully resolved,
hash-pinned file, not from `backend/requirements.txt`.

| File | Role |
|---|---|
| `backend/requirements.txt` | Human-edited source: direct dependencies plus security floors and pins. Edit this one. |
| `backend/requirements-build.in` / `.lock` | Build backend (`setuptools`) for the one sdist-only dependency; see below. |
| `backend/requirements.lock` | Generated. Every direct and transitive package pinned with `sha256` hashes for all platforms (including linux x86_64 and aarch64). Never edit by hand. |

Both `backend/Dockerfile` and `backend/Dockerfile.prod` install with
`--only-binary :all: --require-hashes`. Pip therefore never runs a package's
`setup.py` and rejects any file whose hash is not in the lock (SonarCloud
`docker:S8541` / `docker:S8544`, #1378).

## Regenerating the lock

After any change to `backend/requirements.txt`:

```bash
pip install --require-hashes -r scripts/uv-requirements.txt   # pinned uv; or brew install uv at the same version
scripts/lock-backend-requirements.sh
git add backend/requirements.txt backend/requirements.lock backend/requirements-build.lock
```

The script runs `uv pip compile --universal --python-version 3.12
--generate-hashes`, so one lock covers every platform for the images' Python
(`python:3.12-slim`). uv (Apache-2.0 / MIT, 0.12.22) is pinned in the script so output is
identical locally and in CI. Existing pins are kept unless `requirements.txt`
forces a change; to pick up newer transitive versions, delete
`backend/requirements.lock` and rerun the script.

The `backend-lock-check` CI job runs `scripts/lock-backend-requirements.sh
--check` (after a network-free `--self-test`) on any MR touching `requirements.txt`, the locks or the script and fails when they
disagree.

## The dj-rest-auth sdist exception

`dj-rest-auth` publishes only a source distribution on PyPI (re-checked for
7.1.1; it is the only such package). The Dockerfiles pass
`--no-binary dj-rest-auth`, which overrides `--only-binary :all:` for that single
package and builds it into a wheel in the builder stage. Exactly what is and is
not verified:

- Verified: every wheel and the `dj-rest-auth` sdist against their `sha256` in
  `requirements.lock`.
- Verified: the build backend. `backend/requirements-build.lock` hash-pins
  `setuptools`; the builder installs it with `--only-binary :all:
  --require-hashes`, then builds with `--no-build-isolation`, so pip fetches no
  unpinned build requirement. The package's `setup.py` does run, in the builder
  stage only.
- Not verifiable: the hash of the locally built `dj-rest-auth` wheel. The runtime
  stage installs `/wheels/*.whl` with `--no-index --no-deps`; the other wheels in
  it were hash-checked in the builder. Both Dockerfiles use a builder/runtime
  split, so `setuptools` and the build toolchain never ship in the images.
- CI installs uv from `scripts/uv-requirements.txt` with `--require-hashes`.

If upstream starts publishing a wheel, drop `--no-binary`,
`--no-build-isolation` and `requirements-build.*`. If another sdist-only package
appears, `uv pip compile --only-binary :all:` fails loudly; add it to the same
`--no-binary` list with a note here and make sure its build requirements are in
`requirements-build.in`.

## CI test jobs

Test jobs still `pip install -r backend/requirements.txt`. They do not build
images, so by design they track the latest compatible releases and catch
upstream breakage early; only the shipped images install from the lock.

`backend-dep-scan` audits `requirements.lock` with `pip-audit --require-hashes`.
