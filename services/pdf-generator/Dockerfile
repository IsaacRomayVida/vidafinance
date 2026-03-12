FROM node:20
WORKDIR /app
RUN apt-get update && apt-get install -y fonts-liberation libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 libnss3 libxcomposite1 libxdamage1 libxrandr2 xdg-utils --no-install-recommends && rm -rf /var/lib/apt/lists/*
COPY package*.json .
RUN npm ci --production
COPY . .
EXPOSE 3003
CMD ["node", "index.js"]
