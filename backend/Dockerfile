# ── Stage 1: Build wheels ────────────────────────────────────────────────────
# Installs gcc and compiles any C-extension wheels (psycopg2, etc.).
FROM python:3.12-slim AS builder

WORKDIR /build

# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
# No compiler — only the PostgreSQL client library and pre-built wheels.
FROM python:3.12-slim

# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /wheels /wheels
COPY requirements.txt .
RUN pip install --no-cache-dir --no-index --find-links=/wheels -r requirements.txt \
    && rm -rf /wheels

COPY . .

RUN addgroup --system --gid 1001 visiban \
    && adduser --system --uid 1001 --ingroup visiban visiban \
    && chown -R visiban:visiban /app

USER visiban

EXPOSE 8000
