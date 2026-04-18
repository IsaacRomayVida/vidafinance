# Built from the monorepo repo root as context.
# Railway config: Root Directory = (unset), RAILWAY_DOCKERFILE_PATH = services/payment-server/Dockerfile
FROM node:22-alpine
WORKDIR /app

# Install deps at /app so both service code and shared/ files can resolve them
COPY services/payment-server/package*.json ./
RUN npm ci --only=production

# Copy shared module
COPY services/shared/ ./services/shared/

# Copy the service source
COPY services/payment-server/ ./services/payment-server/

WORKDIR /app/services/payment-server
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1
CMD ["node", "index.js"]
