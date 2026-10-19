# Brygadzista: server (+ dashboard once apps/dashboard exists) in one image.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

# Manifests first so the dependency layer is cached between code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

RUN pnpm --filter @brygadzista/server build \
 && pnpm --filter @brygadzista/server deploy --legacy --prod /out/server \
 && cp -r apps/server/dist /out/server/dist

# The dashboard is optional until its epic lands; the server serves whatever is in /out/dashboard.
RUN mkdir -p /out/dashboard \
 && if [ -f apps/dashboard/package.json ]; then \
      pnpm --filter ./apps/dashboard build && cp -r apps/dashboard/dist/. /out/dashboard/; \
    fi

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
