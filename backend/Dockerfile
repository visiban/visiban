# BASE_REGISTRY lets CI rewrite the Docker Hub pull to the GitLab Dependency
# Proxy (--build-arg BASE_REGISTRY=${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX},
# #1198) without touching local/contributor builds, which get the Docker Hub
# default with no arguments needed.
ARG BASE_REGISTRY=docker.io/library

# ── Stage 1: Build wheels ────────────────────────────────────────────────────
# Installs gcc and compiles any C-extension wheels (other sdist-only packages;
# psycopg itself installs from the psycopg-binary wheel).
FROM ${BASE_REGISTRY}/python:3.12-slim AS builder

WORKDIR /build

# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

# requirements.lock is the hash-pinned, fully resolved lock generated from
# requirements.txt (see docs/development/dependency-lock.md, #1378).
# --only-binary :all: refuses to run any package's setup.py and --require-hashes
# rejects any file whose sha256 is not in the lock. The one exception is
# dj-rest-auth, which publishes only an sdist upstream: --no-binary for that
# single package builds it into a wheel here. Its sdist hash is verified, and
# its build backend (setuptools) is installed first from the hash-pinned
# requirements-build.lock and used with --no-build-isolation, so nothing is
# fetched unpinned. The builder stage is discarded, so setuptools never ships.
COPY requirements.lock requirements-build.lock ./
# pip is upgraded first, from the hash-pinned lock, and its version asserted (#1927):
# pip < 26.2.2 always uses its own vendored certifi, which trusts the compromised
# eMudhra emSign intermediates, and python:3.12-slim still ships pip 26.2.1.
# REMOVABLE once the base image ships pip >= 26.2.2 (drop pip from
# requirements-build.in and the assertion below).
RUN pip install --no-cache-dir --only-binary :all: --require-hashes -r requirements-build.lock \
    && python -c "import pip,sys; v=tuple(map(int,pip.__version__.split('.')[:3])); sys.exit(0 if v>=(26,2,2) else 'pip '+pip.__version__+' < 26.2.2')" \
    && pip wheel --no-cache-dir --only-binary :all: --no-binary dj-rest-auth \
    --no-build-isolation --require-hashes --wheel-dir /wheels -r requirements.lock

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
# No compiler — only the PostgreSQL client library and pre-built wheels.
FROM ${BASE_REGISTRY}/python:3.12-slim

# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Every wheel in /wheels was hash-verified against requirements.lock in the
# builder stage (the dj-rest-auth wheel is built locally from a hash-verified
# sdist, so its own hash cannot be pre-recorded). Dependencies are already
# resolved by the lock, hence --no-deps.
COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir --no-index --no-deps --only-binary :all: /wheels/*.whl \
    && rm -rf /wheels

COPY . .

# Create /app/media and /app/staticfiles so they are owned by the service user
# before docker-compose.prod.yml's named volumes mount over them. Without the
# mkdir, Docker creates the mount point root:root on first boot and
# collectstatic (uid 1001) fails with PermissionError. backend/Dockerfile.prod
# already had this; the release image is built from THIS file (#2463).
RUN addgroup --system --gid 1001 visiban \
    && adduser --system --uid 1001 --ingroup visiban visiban \
    && mkdir -p /app/media /app/staticfiles \
    && chown -R visiban:visiban /app

USER visiban

EXPOSE 8000
