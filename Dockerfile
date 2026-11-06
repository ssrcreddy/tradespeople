# One image per role; the API and worker share one (design §5: same code, two modes).
FROM node:24-bookworm-slim AS base
# libheif-examples: native HEIC decoding, ~5x faster than the JS fallback (Day-1 spike).
RUN apt-get update && apt-get install -y --no-install-recommends libheif-examples ca-certificates \
    && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY spikes/package.json spikes/
RUN pnpm install --frozen-lockfile

FROM base AS api
COPY packages packages
COPY apps/api apps/api
COPY data data
ENV NODE_ENV=production
USER node
# Compose overrides this for the worker and the migrate step.
CMD ["node", "apps/api/src/server.ts"]

FROM base AS web-build
COPY apps/web apps/web
# Rewrites are fixed at build time.
ARG API_ORIGIN=http://api:8080
ENV API_ORIGIN=$API_ORIGIN
RUN pnpm --filter @qa/web build

FROM web-build AS web
ENV NODE_ENV=production
USER node
WORKDIR /app/apps/web
CMD ["node_modules/.bin/next", "start", "--port", "3000"]
