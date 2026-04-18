# Built from the monorepo repo root as context.
# Railway config: Root Directory = (unset), RAILWAY_DOCKERFILE_PATH = services/pdf-generator/Dockerfile
FROM ghcr.io/puppeteer/puppeteer:21
USER root
WORKDIR /app

COPY services/pdf-generator/package*.json ./
RUN npm ci --only=production

COPY services/shared/ ./services/shared/
COPY services/pdf-generator/ ./services/pdf-generator/

WORKDIR /app/services/pdf-generator
EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3004/health || exit 1
CMD ["node", "index.js"]
