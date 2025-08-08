FROM node:20-bullseye

RUN apt-get update && apt-get install -y \
  curl python3 build-essential pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "server.js"]