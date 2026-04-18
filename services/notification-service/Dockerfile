# Built from the monorepo repo root as context.
# Railway config: Root Directory = (unset), RAILWAY_DOCKERFILE_PATH = services/notification-service/Dockerfile
# Multi-stage: builder compiles TypeScript, runtime has prod deps only.
FROM node:22-alpine AS builder
WORKDIR /app
COPY services/notification-service/package*.json ./
RUN npm ci
COPY services/notification-service/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY services/notification-service/package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3003/health || exit 1
CMD ["node", "dist/index.js"]
