FROM node:22-bookworm-slim
WORKDIR /app
COPY --chown=node:node server.cjs index.html privacidade.html termos.html ./
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.cjs"]
