FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY assets ./assets
COPY scripts/migration/runtime/*.cjs ./
COPY scripts/migration/railway-bridge/server.cjs ./bridge.cjs
USER node
CMD ["node", "probe.cjs"]
