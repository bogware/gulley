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

FROM build AS prod-deps
# Per-app production dependency trees via `pnpm deploy`: each app gets ONLY its own
# production dependencies (plus the workspace packages it uses), resolved from the
# lockfile — devDependencies (tsx, esbuild, vitest, drizzle-kit, PGlite) and other
# workspaces' packages (the console's next/playwright) never enter the runtime.
# A hoisted workspace install would have linked the whole lockfile.
# Hoisted layout INSIDE each deploy: the bundles inline the workspace packages, so
# their transitive third-party imports must sit at the top level of that tree.
# The final rm prunes what the bundles never import: @gulley/cli's tsx (only its
# global bin shim needs it) and PGlite, which pnpm carries as drizzle-orm's
# optional-peer resolution.
RUN pnpm --filter @gulley/gateway deploy --prod --config.node-linker=hoisted /out/gateway  && pnpm --filter @gulley/control-api deploy --prod --config.node-linker=hoisted /out/control-api  && rm -rf /out/*/node_modules/tsx /out/*/node_modules/esbuild /out/*/node_modules/@esbuild            /out/*/node_modules/get-tsconfig /out/*/node_modules/@electric-sql

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    CONTROL_API_PORT=8081 GATEWAY_PORT=8080 \
    GULLEY_MIGRATIONS_DIR=/app/dist/migrations
# Each entry resolves its packages from the node_modules beside it (Node walks up from
# the entry file's directory), so the two trees never mix.
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist
COPY --from=prod-deps --chown=nonroot:nonroot /out/gateway/node_modules ./dist/gateway/node_modules
COPY --from=prod-deps --chown=nonroot:nonroot /out/control-api/node_modules ./dist/control-api/node_modules
EXPOSE 8081 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD \
  ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.CONTROL_API_PORT||8081)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["dist/control-api/main.mjs"]
