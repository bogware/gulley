# syntax=docker/dockerfile:1
# Multi-stage image for the Gulley data plane. Runs via tsx with Node as PID 1
# so SIGTERM reaches the graceful-drain handler directly. Further hardening
# (tsup/esbuild bundle + gcr.io/distroless/nodejs22 base, no tsx/pnpm at runtime)
# is a documented follow-up. Build for the ECS task platform: --platform linux/arm64.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/gateway/package.json apps/gateway/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @gulley/gateway...

FROM base AS runtime
ENV NODE_ENV=production GATEWAY_PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY . .
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD \
  node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Node is PID 1 (direct signal delivery for graceful drain).
CMD ["node", "--import", "tsx", "apps/gateway/src/main.ts"]
