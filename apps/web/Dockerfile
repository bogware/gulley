# syntax=docker/dockerfile:1
# Web (Next.js admin console) image. Built from the repo ROOT so pnpm can resolve the
# workspace:
#   docker buildx build --platform linux/arm64 -f apps/web/Dockerfile .
# The browser talks only to this origin: NEXT_PUBLIC_CONTROL_API_URL defaults to the
# same-origin `/control`, and app/control/[...path]/route.ts proxies /control/* to the
# control-api named by the RUNTIME env CONTROL_API_URL (read per request — one image
# serves any environment). The runtime is Next's self-contained standalone server on a
# distroless Node base: no pnpm, no next CLI, no shell. Node is PID 1. The os-patch
# stage overlays Debian's current security builds of the base's OS packages (libssl3)
# so the image never ships a lagging base library (see apps/gateway/Dockerfile).
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
# next build self-hosts IBM Plex via next/font/google, so the build stage needs network.
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @gulley/web...
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 NEXT_STANDALONE=1
RUN pnpm --filter @gulley/web build

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
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
# The standalone output mirrors the monorepo layout (outputFileTracingRoot = repo root):
# apps/web/server.js + the traced node_modules it needs; static assets sit beside it.
COPY --from=build --chown=nonroot:nonroot /app/apps/web/.next/standalone ./
COPY --from=build --chown=nonroot:nonroot /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD \
  ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["apps/web/server.js"]
