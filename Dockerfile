# Brygadzista: server + built dashboard + the browser version of the Expo app in one image.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

# Manifests first so the dependency layer is cached between code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
# Only the server and dashboard here; the Expo app gets its own stage below.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @brygadzista/server... --filter @brygadzista/dashboard...

RUN pnpm --filter @brygadzista/server build \
 && pnpm --filter @brygadzista/server deploy --legacy --prod /out/server \
 && cp -r apps/server/dist /out/server/dist

RUN pnpm --filter @brygadzista/dashboard build \
 && mkdir -p /out/dashboard && cp -r apps/dashboard/dist/. /out/dashboard/

# Web export of the Expo app, served by the server under /app. A separate stage keeps
# React Native and Metro out of the runtime image. It starts from the build stage on purpose:
# BuildKit runs independent stages at once, and two pnpm installs plus Metro in parallel ran
# the 8 GB server out of memory (SIGKILL) while other projects' CI was running.
FROM build AS mobile-web
ENV EXPO_NO_TELEMETRY=1
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @brygadzista/mobile...
RUN pnpm --filter @brygadzista/mobile export:web

# LibreDWG reads DWG drawings (#154). Debian bookworm has no package, so it is built from the release, statically, and
# only the two programs go into the runtime image. It runs as a separate program, like poppler.
FROM debian:bookworm-slim AS libredwg
ARG LIBREDWG_VERSION=0.13.3
ARG LIBREDWG_SHA256=83f1f6e78a744777a481ff4520e4cef3f8ac4b2c1c25671077ca12fe81e8816e
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSL -o libredwg.tar.xz \
      "https://github.com/LibreDWG/libredwg/releases/download/${LIBREDWG_VERSION}/libredwg-${LIBREDWG_VERSION}.tar.xz" \
 && echo "${LIBREDWG_SHA256}  libredwg.tar.xz" | sha256sum -c - \
 && tar xf libredwg.tar.xz --strip-components=1 \
 && ./configure --disable-shared --disable-bindings --disable-python \
 && make -C src -j2 \
 && make -C programs -j2 dwg2dxf dwgread \
 && mkdir -p /opt/libredwg/bin \
 && cp programs/dwg2dxf programs/dwgread /opt/libredwg/bin/

FROM node:22-bookworm-slim AS runtime
# LibreOffice turns Word descriptions into PDF on upload (#157): only Writer, in the build without a GUI (about
# 300 MB), plus fonts metric-compatible with Times New Roman, Arial, Calibri and Cambria so pages break as in Word.
# For CAD drawings (#155): Python with ezdxf draws each sheet as SVG and rsvg-convert turns the SVGs into one PDF.
ARG EZDXF_VERSION=1.4.5
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils fonts-dejavu-core \
      libreoffice-core-nogui libreoffice-writer-nogui fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea \
      librsvg2-bin python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/cad \
 && /opt/cad/bin/pip install --no-cache-dir "ezdxf==${EZDXF_VERSION}"
COPY --from=libredwg /opt/libredwg/bin/ /usr/local/bin/
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    DASHBOARD_DIR=/app/dashboard \
    MOBILE_WEB_DIR=/app/mobile-web \
    COPILOTKIT_TELEMETRY_DISABLED=true \
    CAD_PYTHON=/opt/cad/bin/python
WORKDIR /app/server
COPY --from=build --chown=node:node /out/server ./
COPY --from=build --chown=node:node /repo/apps/server/cad ./cad
COPY --from=build --chown=node:node /out/dashboard /app/dashboard
COPY --from=mobile-web --chown=node:node /repo/apps/mobile/dist-web /app/mobile-web
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
