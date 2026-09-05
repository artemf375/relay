# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/relayctl/package.json packages/relayctl/package.json
RUN pnpm install --frozen-lockfile
COPY apps/server apps/server
COPY packages/contracts packages/contracts
COPY packages/relayctl packages/relayctl
RUN pnpm --filter @relay/contracts build \
  && pnpm --filter @relay/server build \
  && pnpm --filter @relay/server deploy --prod --legacy /out

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client restic ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=8787
ENV RELAY_DATABASE_URL=/data/relay.sqlite
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
COPY --from=build --chown=node:node /repo/apps/server/dist ./dist
COPY --chown=node:node deploy/backup-loop.sh ./scripts/backup-loop.sh
RUN chmod 0555 ./scripts/backup-loop.sh \
  && mkdir -p /data /backup /home/node/.ssh \
  && chown -R node:node /data /backup /home/node/.ssh
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
