# syntax=docker/dockerfile:1
# Control-plane image. Node is PID 1 (SIGTERM reaches the drain handler); a
# tsup bundle + distroless base is a documented further-hardening step.
# Build for the ECS task platform: --platform linux/arm64.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/control-api/package.json apps/control-api/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @gulley/control-api...

FROM base AS runtime
ENV NODE_ENV=production CONTROL_API_PORT=8081
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY . .
EXPOSE 8081
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD \
  node -e "fetch('http://127.0.0.1:'+(process.env.CONTROL_API_PORT||8081)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/control-api/src/main.ts"]
