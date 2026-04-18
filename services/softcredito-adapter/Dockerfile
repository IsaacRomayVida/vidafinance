# Built from the monorepo repo root as context.
# Railway config: Root Directory = (unset), RAILWAY_DOCKERFILE_PATH = services/softcredito-adapter/Dockerfile
FROM node:22.15-alpine3.21
WORKDIR /app

# Install the service's deps at /app/node_modules so Node's module resolution
# can find them from both services/softcredito-adapter/ AND services/shared/ files.
COPY services/softcredito-adapter/package*.json ./
RUN npm ci --only=production

# Copy the shared module (../shared/ relative to the service at runtime)
COPY services/shared/ ./services/shared/

# Copy the service source
COPY services/softcredito-adapter/ ./services/softcredito-adapter/

# Run from the service directory so relative requires (../shared/alerting) resolve
WORKDIR /app/services/softcredito-adapter

EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3002/health || exit 1
CMD ["node", "index.js"]
