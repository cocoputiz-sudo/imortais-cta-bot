# MackNa Cloud BTV11 experimental runtime. Image built externally for linux/arm64.
FROM node:22-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src/ ./src/
COPY assets/ ./assets/
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
