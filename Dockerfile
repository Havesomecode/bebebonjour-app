FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY server ./server
COPY scripts ./scripts
COPY schemas ./schemas
COPY data ./data
ENV NODE_ENV=production
CMD ["node", "server/railway.mjs"]
