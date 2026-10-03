ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS frontend
WORKDIR /build
COPY frontweb/package*.json ./
RUN npm ci
COPY frontweb/ ./
RUN npm run build

FROM ${NODE_IMAGE} AS backend-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY backend-node/package*.json ./
RUN npm ci --omit=dev

FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend-node
COPY --chown=node:node backend-node/ ./
COPY --from=backend-deps --chown=node:node /build/node_modules ./node_modules
COPY --from=frontend --chown=node:node /build/dist /app/frontweb/dist
COPY --chown=node:node deploy/config.production.yaml ./configs/config.yaml
RUN mkdir -p /app/backend-node/data/storage && chown -R node:node /app/backend-node/data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5680
USER node
EXPOSE 5680
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:5680/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
