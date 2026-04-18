# Built from the monorepo repo root as context.
# Railway config: Root Directory = (unset), RAILWAY_DOCKERFILE_PATH = services/underwriting-service/Dockerfile
FROM node:22-alpine
WORKDIR /app

COPY services/underwriting-service/package*.json ./
RUN npm ci --only=production

COPY services/shared/ ./services/shared/
COPY services/underwriting-service/ ./services/underwriting-service/

WORKDIR /app/services/underwriting-service
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3003/health || exit 1
CMD ["node", "index.js"]
