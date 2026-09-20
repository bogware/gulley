# syntax=docker/dockerfile:1
# Web (Next.js admin console) image. Built from the repo ROOT so pnpm can resolve the
# workspace:
#   docker buildx build --platform linux/arm64 -f apps/web/Dockerfile .
# The browser talks only to this origin: NEXT_PUBLIC_CONTROL_API_URL defaults to the
# same-origin `/control`, and app/control/[...path]/route.ts proxies /control/* to the
# control-api named by the RUNTIME env CONTROL_API_URL (read per request — one image
# serves any environment). The runtime is Next's self-contained standalone server on a
# distroless Node base: no pnpm, no next CLI, no shell. Node is PID 1.
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

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
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
