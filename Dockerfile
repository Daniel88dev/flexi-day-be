# build stage
FROM node:22-alpine AS builder
LABEL authors="danielhrynusiw"
WORKDIR /app

# dependencies
COPY package*.json ./
RUN npm ci

# copy sources
COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY src ./src
RUN npm run build

# Sentry source maps: inject debug IDs into the built JS and upload the maps so
# production stack traces resolve to TypeScript source. Skipped when the
# sentry_auth_token build secret is absent (e.g. local `docker build`), so the
# image still builds without Sentry credentials. APP_VERSION (git SHA) is the
# release, matching `release` in src/instrument.ts.
ARG APP_VERSION=unknown
ARG SENTRY_ORG=freelancer-ldp
ARG SENTRY_PROJECT=flexi-day-be
RUN --mount=type=secret,id=sentry_auth_token \
  if [ -f /run/secrets/sentry_auth_token ]; then \
    export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token)"; \
    npx @sentry/cli sourcemaps inject ./dist && \
    npx @sentry/cli sourcemaps upload \
      --org "$SENTRY_ORG" --project "$SENTRY_PROJECT" --release "$APP_VERSION" ./dist; \
  else \
    echo "sentry_auth_token secret not provided; skipping source map upload"; \
  fi

# runtime stage
FROM node:22-alpine AS runner
WORKDIR /app

# safe defaults
ENV NODE_ENV=production
ENV PORT=8080

# Stamp the build so logs report which image is running (buildInfo.version).
# Passed from CI (--build-arg APP_VERSION=<git sha>); defaults to "unknown".
ARG APP_VERSION=unknown
ENV APP_VERSION=${APP_VERSION}

# install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

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