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

# install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

RUN mkdir -p /app/logs && chown -R node:node /app/logs

# copy build files and runtime assets
COPY --from=builder --chown=node:node /app/dist ./dist

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]