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

CMD ["node", "dist/index.js"]