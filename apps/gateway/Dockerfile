# syntax=docker/dockerfile:1
# Monorepo image for Gulley. It installs BOTH apps' dependency trees, so the same
# image runs either the gateway or the control-api — the ECS task definition picks
# the command. Node is PID 1 (SIGTERM reaches the graceful-drain handler). Further
# hardening (tsup/esbuild bundle + gcr.io/distroless/nodejs22 base, no tsx/pnpm at
# runtime) is a documented follow-up. Build for the ECS task platform:
#   docker buildx build --platform linux/arm64 -f apps/gateway/Dockerfile .
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
# Copy the whole workspace so pnpm can resolve every `workspace:*` dependency,
# then install the closure for BOTH apps.
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @gulley/gateway... --filter @gulley/control-api...

FROM base AS runtime
ENV NODE_ENV=production GATEWAY_PORT=8080 CONTROL_API_PORT=8081
COPY --from=deps /app ./
EXPOSE 8080 8081
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD \
  node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Run from the app dir: pnpm's isolated linker installs `tsx` under
# apps/<app>/node_modules, so `node --import tsx` only resolves it from there.
# Node stays PID 1 (SIGTERM reaches the graceful-drain handler).
WORKDIR /app/apps/gateway
# Default to the gateway; the ECS task definition overrides `command`/`workingDirectory` for control-api.
CMD ["node", "--import", "tsx", "src/main.ts"]
