FROM node:20-alpine AS base

# Build tools for ethers native deps
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production
RUN apk del python3 make g++

COPY . .

EXPOSE 3004

CMD ["node", "index.js"]
