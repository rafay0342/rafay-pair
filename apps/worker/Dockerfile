# syntax=docker/dockerfile:1.7
FROM node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.20.0
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json .npmrc ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
COPY packages/event-contracts/package.json packages/event-contracts/package.json
COPY services/realtime/package.json services/realtime/package.json
COPY services/notifications/package.json services/notifications/package.json
RUN pnpm install --frozen-lockfile
COPY apps/worker apps/worker
COPY packages/api-contracts packages/api-contracts
COPY packages/event-contracts packages/event-contracts
COPY services/realtime services/realtime
COPY services/notifications services/notifications
RUN pnpm --filter @rafay-pair/worker... build
# node-linker=hoisted materializes workspace packages as real files; the
# default symlinks would point back into this discarded build stage.
RUN pnpm --config.node-linker=hoisted --filter @rafay-pair/worker deploy --prod --legacy /prod/apps/worker

FROM node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7 AS production
ENV NODE_ENV=production \
  DATABASE_CA_CERT_PATH=/app/certs/aws-rds-global-bundle.pem
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
  && groupadd --system --gid 10001 rafay \
  && useradd --system --uid 10001 --gid rafay --home-dir /app rafay
ADD --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3 \
  --chown=rafay:rafay --chmod=0444 \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  /app/certs/aws-rds-global-bundle.pem
RUN chmod 0555 /app/certs
COPY --from=build --chown=rafay:rafay /prod /app
USER 10001:10001
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/worker/dist/main.js"]
