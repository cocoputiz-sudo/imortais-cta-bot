FROM node:22-bookworm-slim
WORKDIR /app
COPY server.cjs ./
USER node
ENV PORT=8080
CMD ["node", "server.cjs"]
