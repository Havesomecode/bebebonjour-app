FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d
# Existing narration commands validate real media duration with ffprobe.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && apt-get clean
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node migration/railway/package.json migration/railway/package-lock.json ./migration/railway/
RUN npm --prefix migration/railway ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node schemas ./schemas
COPY --chown=node:node data ./data
COPY --chown=node:node template ./template
COPY --chown=node:node bin ./bin
COPY --chown=node:node test/integration/fulfillment-workflow-tracer.test.mjs ./test/integration/fulfillment-workflow-tracer.test.mjs
COPY --chown=node:node migration/railway/*.mjs migration/railway/schema.sql ./migration/railway/
COPY --chown=node:node migration/railway/current-loop ./migration/railway/current-loop
COPY --chown=node:node migration/railway/test ./migration/railway/test
RUN test ! -e .git && test ! -e node_modules/vercel && npm --prefix migration/railway run check
USER node
EXPOSE 3001
CMD ["node", "migration/railway/server.mjs"]
