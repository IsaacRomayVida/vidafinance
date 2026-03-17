FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json .
RUN npm ci
COPY tsconfig.json .
COPY src/ src/
RUN npx tsc

FROM node:20-slim
WORKDIR /app

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json .
RUN npm ci --only=production
COPY --from=builder /app/dist/ dist/
COPY templates/ templates/
EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3004/health || exit 1
CMD ["node", "dist/index.js"]
