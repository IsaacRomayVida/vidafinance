FROM node:20-alpine
WORKDIR /app
COPY package*.json .
RUN npm ci --production
COPY . .
EXPOSE 3004
CMD ["node", "index.js"]
