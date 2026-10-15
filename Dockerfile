# syntax=docker/dockerfile:1.7
# Production images. Targets:
#   api     — API server; the same image runs the worker, migrations, backup and restore
#   webapp  — one Next.js interface, chosen with --build-arg APP=admin|provider|web
# Behind a TLS-intercepting proxy, pass its CA as a build secret: --secret id=ca,src=ca.crt
# (used only during the build, never stored in the image).

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PG_IMAGE=postgres:16

FROM ${NODE_IMAGE} AS manifests
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
COPY apps/provider/package.json apps/provider/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
COPY packages/web-kit/package.json packages/web-kit/
COPY e2e/package.json e2e/

# ---------------------------------------------------------------- API
FROM manifests AS api-build
RUN --mount=type=secret,id=ca,required=false --mount=type=cache,target=/root/.npm \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci -w apps/api
COPY apps/api apps/api
RUN npm -w apps/api run build

FROM manifests AS api-deps
RUN --mount=type=secret,id=ca,required=false --mount=type=cache,target=/root/.npm \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci -w apps/api --omit=dev

# Runtime on the official PostgreSQL 16 image: pg_dump/pg_restore match the server exactly (needed by
# backup/restore) without any package repository at build time; Node comes from the Node image (both
# are Debian, and Node runs on the same or newer glibc).
FROM ${PG_IMAGE} AS api
# Chromium prints documents and contracts to PDF (pass --build-arg WITH_PDF=false to leave it out; the print views still work).
ARG WITH_PDF=true
RUN if [ "$WITH_PDF" = "true" ]; then apt-get update && apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*; fi
COPY --from=manifests /usr/local/bin/node /usr/local/bin/node
RUN useradd --system --uid 10001 --create-home app && node --version >/dev/null && pg_dump --version >/dev/null
ENTRYPOINT []
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 STORAGE_DIR=/data/storage BACKUP_DIR=/data/backups
WORKDIR /app
COPY --from=api-deps /repo/node_modules ./node_modules
COPY --from=api-deps /repo/apps/api/package.json ./apps/api/package.json
COPY --from=api-build /repo/apps/api/dist ./apps/api/dist
COPY apps/api/migrations ./apps/api/migrations
RUN mkdir -p /data/storage /data/backups /data/restore-drill && chown -R app:app /data
USER app
WORKDIR /app/apps/api
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Other roles: node dist/worker.js | node dist/scripts/migrate.js | node dist/scripts/backup.js | node dist/scripts/restore.js
CMD ["node", "dist/server.js"]

# ---------------------------------------------------------------- Web interfaces
FROM manifests AS webapp-build
ARG APP
RUN test -n "$APP" || (echo "build with --build-arg APP=admin|provider|web" && exit 1)
RUN --mount=type=secret,id=ca,required=false --mount=type=cache,target=/root/.npm \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci -w apps/${APP}
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/${APP} apps/${APP}
# Public build-time settings (inlined into the browser code).
ARG NEXT_PUBLIC_BRAND_AR=
ARG NEXT_PUBLIC_BRAND_EN=
ENV NEXT_STANDALONE=1 NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_BRAND_AR=${NEXT_PUBLIC_BRAND_AR} NEXT_PUBLIC_BRAND_EN=${NEXT_PUBLIC_BRAND_EN}
RUN npm -w apps/${APP} run build && mkdir -p apps/${APP}/public

FROM ${NODE_IMAGE} AS webapp
ARG APP
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 APP_DIR=apps/${APP}
WORKDIR /app
COPY --from=webapp-build --chown=node:node /repo/apps/${APP}/.next/standalone ./
COPY --from=webapp-build --chown=node:node /repo/apps/${APP}/.next/static ./apps/${APP}/.next/static
COPY --from=webapp-build --chown=node:node /repo/apps/${APP}/public ./apps/${APP}/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "exec node \"$APP_DIR/server.js\""]
