FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY scripts/migration/runtime/probe.cjs ./probe.cjs
USER node
CMD ["node", "probe.cjs"]
