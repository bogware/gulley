# syntax=docker/dockerfile:1
# The control-api ships in the SAME runtime image as the gateway (see
# apps/gateway/Dockerfile for the build/prod-deps/runtime stages). This Dockerfile
# builds an equivalent image whose default command is the control-api, for setups that
# prefer a dedicated image per service.
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
ARG GULLEY_VERSION=""
ARG GULLEY_BUILD_SHA=""
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @gulley/gateway... --filter @gulley/control-api...
RUN GULLEY_VERSION="${GULLEY_VERSION:-0.0.0}" GULLEY_BUILD_SHA="$GULLEY_BUILD_SHA" node scripts/bundle.mjs

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/control-api/package.json apps/control-api/package.json
COPY packages ./packages
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --config.node-linker=hoisted \
      --filter @gulley/gateway... --filter @gulley/control-api...

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    CONTROL_API_PORT=8081 GATEWAY_PORT=8080 \
    GULLEY_MIGRATIONS_DIR=/app/dist/migrations
COPY --from=prod-deps --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist
EXPOSE 8081 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD \
  ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.CONTROL_API_PORT||8081)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["dist/control-api/main.mjs"]
