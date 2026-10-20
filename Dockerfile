# Brygadzista: server + built dashboard in one image.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

# Manifests first so the dependency layer is cached between code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
# Only the server and dashboard; the Expo app is not part of the image.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @brygadzista/server... --filter @brygadzista/dashboard...

RUN pnpm --filter @brygadzista/server build \
 && pnpm --filter @brygadzista/server deploy --legacy --prod /out/server \
 && cp -r apps/server/dist /out/server/dist

RUN pnpm --filter @brygadzista/dashboard build \
 && mkdir -p /out/dashboard && cp -r apps/dashboard/dist/. /out/dashboard/

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    DASHBOARD_DIR=/app/dashboard \
    COPILOTKIT_TELEMETRY_DISABLED=true
WORKDIR /app/server
COPY --from=build --chown=node:node /out/server ./
COPY --from=build --chown=node:node /out/dashboard /app/dashboard
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
