# Built from the monorepo repo root as context.
# Railway config: Root Directory = (unset), RAILWAY_DOCKERFILE_PATH = services/softcredito-adapter/Dockerfile
FROM node:22.15-alpine3.21
WORKDIR /app

# Copy the shared module (services/shared/) so ../shared/ resolves from the service directory
COPY services/shared/ ./services/shared/

# Install service deps (cached layer — only invalidates when package*.json changes)
COPY services/softcredito-adapter/package*.json ./services/softcredito-adapter/
WORKDIR /app/services/softcredito-adapter
RUN npm ci --only=production

# Copy the rest of the service source
COPY services/softcredito-adapter/ .

EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3002/health || exit 1
CMD ["node", "index.js"]
