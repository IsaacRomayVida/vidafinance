FROM node:22.15-alpine3.21
WORKDIR /app

# Copy the shared module so ../shared/ resolves from the service directory
COPY shared/ ./shared/

# Install service deps (cached layer — only invalidates when package*.json changes)
COPY softcredito-adapter/package*.json ./softcredito-adapter/
WORKDIR /app/softcredito-adapter
RUN npm ci --only=production

# Copy the rest of the service source
COPY softcredito-adapter/ .

EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3002/health || exit 1
CMD ["node", "index.js"]
