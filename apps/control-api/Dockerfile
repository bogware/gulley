# syntax=docker/dockerfile:1
# The control-api ships in the SAME monorepo image as the gateway (see
# apps/gateway/Dockerfile) — the ECS task definition selects the command. This
# Dockerfile builds an equivalent image whose default command is the control-api,
# for setups that prefer a dedicated image per service. Node is PID 1.
# Build for the ECS task platform: --platform linux/arm64.
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Pull Debian security fixes into the base layer, then enable pnpm.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/* && corepack enable
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
# Run from the app dir so pnpm's isolated `tsx` resolves; Node stays PID 1.
WORKDIR /app/apps/control-api
CMD ["node", "--import", "tsx", "src/main.ts"]
