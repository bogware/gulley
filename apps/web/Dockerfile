# syntax=docker/dockerfile:1
# Web (Next.js admin console) image for ECS Fargate. Built from the repo ROOT so
# pnpm can resolve the workspace:
#   docker buildx build --platform linux/arm64 -f apps/web/Dockerfile .
# The browser talks only to this origin: NEXT_PUBLIC_CONTROL_API_URL defaults to
# the same-origin `/control`, and next.config.mjs rewrites /control/* to the
# control-api given by the runtime CONTROL_API_URL env. Node is PID 1.
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
# next build self-hosts IBM Plex via next/font/google, so the build stage needs
# network access. devDependencies (tailwind/postcss/typescript) are required here.
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @gulley/web...
# Next.js evaluates next.config.mjs rewrites() at BUILD time and bakes the
# destination into the routes manifest, so the control-api the console proxies
# /control/* to must be a BUILD ARG (a runtime env is ignored). Defaults to the
# same-origin dev value. Pass --build-arg CONTROL_API_URL=https://api.<domain>.
ARG CONTROL_API_URL=""
ENV CONTROL_API_URL=$CONTROL_API_URL
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @gulley/web build

FROM base AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app ./
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD \
  node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@gulley/web", "start"]
