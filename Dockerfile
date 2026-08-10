# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.13.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="Free AI Harness" \
      org.opencontainers.image.description="Quota-aware, multi-provider AI gateway" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production \
    HARNESS_PORT=8790 \
    HARNESS_HOST=0.0.0.0 \
    HARNESS_DATA_DIR=/var/lib/free-ai-harness \
    HARNESS_WORKSPACE_ROOT=/workspace

WORKDIR /app
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --chown=10001:10001 scripts/healthcheck.mjs scripts/sqlite-backup.mjs scripts/sqlite-restore.mjs ./scripts/
COPY --chown=10001:10001 LICENSE /licenses/free-ai-harness/LICENSE

RUN install -d -o 10001 -g 10001 -m 0700 /var/lib/free-ai-harness /workspace

USER 10001:10001
EXPOSE 8790
VOLUME ["/var/lib/free-ai-harness", "/workspace"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "scripts/healthcheck.mjs"]

ENTRYPOINT ["node", "dist/src/server.js"]
