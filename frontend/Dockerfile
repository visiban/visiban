# ── Stage 1: Production build ────────────────────────────────────────────────
# Used by docker-compose.prod.yml (target: builder).
# Outputs compiled static files to /app/dist which is mounted as a named volume
# for nginx to serve.
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

# VITE_API_URL="" → frontend uses relative URLs; nginx proxies /api/ and /ws/
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL

COPY . .

# ── Stage 2: Development (default) ───────────────────────────────────────────
# Used by docker-compose.yml. Runs the Vite dev server with hot reload.
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 5173
