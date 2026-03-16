FROM ghcr.io/puppeteer/puppeteer:21
USER root
WORKDIR /app
COPY package*.json .
# Skip Chrome download — base image already provides Chrome at PUPPETEER_EXECUTABLE_PATH
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci --only=production
COPY . .
EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3004/health || exit 1
CMD ["node", "index.js"]
