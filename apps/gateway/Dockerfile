# syntax=docker/dockerfile:1
# Runtime image for Gulley: ONE image runs either plane (the container command picks
# the entry). Three stages:
#   build      — full workspace install, esbuild-bundle both apps (dist/*.mjs) with the
#                version + git sha stamped in.
#   prod-deps  — production-ONLY dependencies of the two apps, installed HOISTED so the
#                bundled entries resolve third-party packages from /app/node_modules.
#   runtime    — distroless Node 22 (no shell, no package manager, no toolchain):
#                dist/ + node_modules/ only. Node is PID 1 (SIGTERM reaches the drain).
#
#   docker buildx build --platform linux/arm64 -f apps/gateway/Dockerfile \
#     --build-arg GULLEY_VERSION=v0.4.0 --build-arg GULLEY_BUILD_SHA=$(git rev-parse --short HEAD) .
#
# Entries (all `node <file>`; the image's default is the gateway):
#   dist/gateway/main.mjs          data plane            dist/gateway/doctor.mjs        preflight
#   dist/control-api/main.mjs      control plane         dist/control-api/migrate.mjs   DB migrations
#   dist/control-api/audit-verify.mjs                    compliance CLI
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
# Hoisted layout: every production package lands flat under /app/node_modules, which is
# where the bundled entries (bare specifiers) resolve from. devDependencies (tsx, vitest,
# esbuild, drizzle-kit, pglite) are NOT installed — the runtime carries no toolchain.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --config.node-linker=hoisted \
      --filter @gulley/gateway... --filter @gulley/control-api...

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    GATEWAY_PORT=8080 CONTROL_API_PORT=8081 \
    GULLEY_MIGRATIONS_DIR=/app/dist/migrations
COPY --from=prod-deps --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist
EXPOSE 8080 8081 9090
# distroless has no shell: exec-form probe through node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD \
  ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# ENTRYPOINT is /nodejs/bin/node (from the base); the command is the entry file.
CMD ["dist/gateway/main.mjs"]
