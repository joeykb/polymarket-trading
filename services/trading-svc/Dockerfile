FROM node:20-alpine AS base

# Build tools for ethers native deps
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy shared module
COPY shared/ /app/shared/

# Copy and install dependencies
COPY services/trading-svc/package.json services/trading-svc/package-lock.json* ./services/trading-svc/
WORKDIR /app/services/trading-svc
RUN npm ci --production
RUN apk del python3 make g++

# Copy service source
COPY services/trading-svc/ /app/services/trading-svc/

EXPOSE 3004
CMD ["node", "index.js"]
