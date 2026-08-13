# syntax=docker/dockerfile:1
# The control-api ships in the SAME monorepo image as the gateway (see
# apps/gateway/Dockerfile) — the ECS task definition selects the command. This
# Dockerfile builds an equivalent image whose default command is the control-api,
# for setups that prefer a dedicated image per service. Node is PID 1.
# Build for the ECS task platform: --platform linux/arm64.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @gulley/control-api... --filter @gulley/gateway...

FROM base AS runtime
ENV NODE_ENV=production CONTROL_API_PORT=8081 GATEWAY_PORT=8080
COPY --from=deps /app ./
EXPOSE 8081 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD \
  node -e "fetch('http://127.0.0.1:'+(process.env.CONTROL_API_PORT||8081)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/control-api/src/main.ts"]
