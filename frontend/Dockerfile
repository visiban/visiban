# ── Stage 1: Builder ─────────────────────────────────────────────────────────
# Installs all deps and compiles the React SPA to /app/dist.
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
# Run npm ci twice to work around the npm optional-dependency bug on Alpine/musl
# (https://github.com/npm/cli/issues/4828) where platform-specific packages like
# @rollup/rollup-linux-arm64-musl are not installed on the first pass.
RUN npm ci --include=dev && npm ci --include=dev

# VITE_API_URL="" → frontend uses relative URLs; nginx proxies /api/ and /ws/
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

# NODE_OPTIONS can be set at build time (e.g. --max-old-space-size=512) to
# cap Node's heap on memory-constrained CI runners.  Empty by default so
# production builds are unaffected.
ARG NODE_OPTIONS=""
ENV NODE_OPTIONS=$NODE_OPTIONS

COPY . .
RUN npm run build

# ── Stage 2: Development ──────────────────────────────────────────────────────
# Used by docker-compose.yml (build.target: dev). Runs the Vite dev server
# with hot reload. Source is mounted as a volume so no COPY needed here.
FROM node:20-alpine AS dev

WORKDIR /app

COPY package*.json ./
# Run npm install twice to work around the npm optional-dependency bug on Alpine/musl
# (https://github.com/npm/cli/issues/4828).
RUN npm install && npm install

COPY . .

EXPOSE 5173

# ── Stage 3: Production (default) ────────────────────────────────────────────
# Serves the compiled SPA with nginx. This is the image pushed to the registry
# and used by the Helm chart — it must be the final stage so Docker and kaniko
# build it by default when no --target is specified.
# nginx base image CMD keeps the process in the foreground:
#   nginx -g "daemon off;"
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
