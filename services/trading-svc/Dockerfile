FROM node:20-alpine AS base

# Build tools for ethers native deps
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./

# Copy service package.json for workspace resolution
COPY services/trading-svc/package.json ./services/trading-svc/

# Install only this workspace's dependencies
RUN npm ci --workspace=services/trading-svc --production
RUN apk del python3 make g++

# Copy shared module
COPY shared/ /app/shared/

# Copy service source
COPY services/trading-svc/ /app/services/trading-svc/

WORKDIR /app/services/trading-svc
EXPOSE 3004
CMD ["node", "index.js"]
