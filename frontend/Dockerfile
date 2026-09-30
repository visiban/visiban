# BASE_REGISTRY lets CI rewrite the Docker Hub pulls below to the GitLab
# Dependency Proxy (--build-arg BASE_REGISTRY=${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX},
# #1198) without touching local/contributor builds, which get the Docker Hub
# default with no arguments needed.
ARG BASE_REGISTRY=docker.io/library

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
# Installs all deps and compiles the React SPA to /app/dist.
FROM ${BASE_REGISTRY}/node:20-alpine AS builder

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
FROM ${BASE_REGISTRY}/node:20-alpine AS dev

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
FROM ${BASE_REGISTRY}/nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html

# 8080, not 80: the Helm chart runs this image as a non-root user (#1224),
# which cannot bind a port below 1024 without CAP_NET_BIND_SERVICE — not
# usable here (see helm/visiban/values.yaml's frontend.securityContext
# comment). The chart's own nginx.conf (templates/frontend-configmap.yaml)
# listens on 8080 to match; docker-compose.yml never builds this stage (it
# uses the `dev` target), so nothing else references this port number.
EXPOSE 8080
