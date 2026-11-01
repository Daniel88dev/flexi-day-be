# syntax=docker/dockerfile:1

# pnpm for the build stages, the same version as packageManager in package.json
FROM node:24-alpine AS pnpm
COPY --from=ghcr.io/pnpm/pnpm:12.16.1-alpine@sha256:3b67e34454e18e4797a50ade3176dde31cec13ad6670f460a81bdf6e1d8b547b /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# build stage
FROM pnpm AS builder
LABEL authors="danielhrynusiw"
RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm \
  pnpm install --frozen-lockfile --store-dir /var/cache/pnpm

# copy sources
COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY src ./src
RUN pnpm run build

# Sentry source maps: inject debug IDs and upload the maps so prod stack traces
# resolve to TS source. Skipped when the sentry_auth_token secret is absent (e.g.
# local docker build). APP_VERSION (git SHA) is the release; must match instrument.ts.
ARG APP_VERSION=unknown
ARG SENTRY_ORG=freelancer-ldp
ARG SENTRY_PROJECT=flexi-day-be
RUN --mount=type=secret,id=sentry_auth_token \
  if [ -f /run/secrets/sentry_auth_token ]; then \
    export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token)"; \
    pnpm exec sentry-cli sourcemaps inject ./dist && \
    pnpm exec sentry-cli sourcemaps upload \
      --org "$SENTRY_ORG" --project "$SENTRY_PROJECT" --release "$APP_VERSION" ./dist; \
  else \
    echo "sentry_auth_token secret not provided; skipping source map upload"; \
  fi

# production dependencies
FROM pnpm AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/var/cache/pnpm \
  pnpm install --frozen-lockfile --prod --store-dir /var/cache/pnpm

# runtime stage: starts with node, so it carries no pnpm
FROM node:24-alpine AS runner
WORKDIR /app

# safe defaults
ENV NODE_ENV=production
ENV PORT=8080

# Stamps buildInfo.version and the Sentry release. Passed from CI (--build-arg APP_VERSION=<git sha>).
ARG APP_VERSION=unknown
ENV APP_VERSION=${APP_VERSION}

# dist is ESM and needs "type": "module" from package.json
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules

RUN mkdir -p /app/logs && chown -R node:node /app/logs

# AWS RDS CA bundle so TLS verification (rejectUnauthorized: true) succeeds
# against RDS. NODE_EXTRA_CA_CERTS adds it to Node's default trust store.
RUN wget -qO /app/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem

# copy build files and runtime assets
COPY --from=builder --chown=node:node /app/dist ./dist

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

# --import loads Sentry (dist/instrument.js) before the app graph so it can
# instrument express/pg/http. Required for ESM; an in-file import is too late.
CMD ["node", "--import", "./dist/instrument.js", "dist/index.js"]
