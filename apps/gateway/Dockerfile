# syntax=docker/dockerfile:1
# Runtime image for Gulley: ONE image runs either plane (the container command picks
# the entry). Four stages:
#   build      — full workspace install, esbuild-bundle both apps (dist/*.mjs) with the
#                version + git sha stamped in.
#   prod-deps  — production-ONLY dependencies per app (`pnpm deploy`), copied next to
#                each bundled entry so it resolves third-party packages from there.
#   os-patch   — Debian's current security builds of the base's OS packages (libssl3),
#                overlaid on the runtime so the image never ships a lagging base lib.
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

# Debian security updates for the runtime's OS packages. The distroless base is
# rebuilt on its own cadence, so between rebuilds a package such as libssl3 can lag a
# Debian security release and fail the release scan. This stage installs the CURRENT
# bookworm build of those packages into a staging root that mirrors the runtime image
# — shared objects AND the dpkg metadata distroless keeps in /var/lib/dpkg/status.d,
# which is what the scanner reads — and the runtime stage overlays it. (Node itself
# links OpenSSL statically; the system libssl3 is not on its load path, so this is
# defence in depth for the image's OS surface, not a runtime fix.) Runs per platform
# under buildx, so the multi-arch paths resolve themselves.
FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS os-patch
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 \
 && arch="$(dpkg --print-architecture)" \
 && libdir="$(dirname "$(ls /usr/lib/*/libssl.so.3)")" \
 && mkdir -p "/patch$libdir" /patch/var/lib/dpkg/status.d \
 && cp "$libdir/libssl.so.3" "$libdir/libcrypto.so.3" "/patch$libdir/" \
 && dpkg -s libssl3 > /patch/var/lib/dpkg/status.d/libssl3 \
 && cp "/var/lib/dpkg/info/libssl3:$arch.md5sums" /patch/var/lib/dpkg/status.d/libssl3.md5sums \
 && rm -rf /var/lib/apt/lists/*

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
COPY --from=os-patch /patch/ /
WORKDIR /app
ENV NODE_ENV=production \
    GATEWAY_PORT=8080 CONTROL_API_PORT=8081 \
    GULLEY_MIGRATIONS_DIR=/app/dist/migrations
# Each entry resolves its packages from the node_modules beside it (Node walks up from
# the entry file's directory), so the two trees never mix.
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist
COPY --from=prod-deps --chown=nonroot:nonroot /out/gateway/node_modules ./dist/gateway/node_modules
COPY --from=prod-deps --chown=nonroot:nonroot /out/control-api/node_modules ./dist/control-api/node_modules
EXPOSE 8080 8081 9090
# distroless has no shell: exec-form probe through node itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD \
  ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# ENTRYPOINT is /nodejs/bin/node (from the base); the command is the entry file.
CMD ["dist/gateway/main.mjs"]
