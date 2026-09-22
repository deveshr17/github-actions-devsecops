# syntax=docker/dockerfile:1.7
#
# Multi-stage build:
#   deps    - install production dependencies only, reproducibly (npm ci)
#   runtime - distroless Node.js 20 image, no shell, non-root UID 65532
#
# HEALTHCHECK is intentionally omitted: Kubernetes probes own health semantics
# and a Docker HEALTHCHECK adds a process that distroless cannot run anyway.

ARG NODE_VERSION=20

# ---------------------------------------------------------------------------
# Stage 1: dependency install
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /app

# Copy manifests first so the dependency layer is cached independently of source.
COPY package.json package-lock.json ./

# npm ci is deterministic against the lockfile; --omit=dev keeps devDependencies out.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime

ARG GIT_SHA=unknown
ARG VERSION=0.0.0-dev
ARG BUILD_DATE=1970-01-01T00:00:00Z

LABEL org.opencontainers.image.title="devsecops-sample-service" \
      org.opencontainers.image.description="Sample Express service for a GitHub Actions DevSecOps pipeline to GKE" \
      org.opencontainers.image.source="https://github.com/deveshr17/github-actions-devsecops" \
      org.opencontainers.image.url="https://github.com/deveshr17/github-actions-devsecops" \
      org.opencontainers.image.documentation="https://github.com/deveshr17/github-actions-devsecops/blob/main/README.md" \
      org.opencontainers.image.vendor="Devesh Rashinkar" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.base.name="gcr.io/distroless/nodejs20-debian12:nonroot"

ENV NODE_ENV=production \
    PORT=8080 \
    SERVICE_VERSION=${VERSION} \
    GIT_SHA=${GIT_SHA}

WORKDIR /app

# Ownership set to the distroless nonroot user (uid/gid 65532) so the runtime
# does not need write access anywhere; the container runs with a read-only root FS.
COPY --from=deps --chown=65532:65532 /app/node_modules ./node_modules
COPY --chown=65532:65532 package.json ./
COPY --chown=65532:65532 src ./src

USER 65532:65532

EXPOSE 8080

# distroless nodejs image ENTRYPOINT is already ["/nodejs/bin/node"]
CMD ["src/server.js"]
