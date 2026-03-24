FROM node:20-alpine

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./

# Copy service package.json for workspace resolution
COPY services/market-svc/package.json ./services/market-svc/

# Install only this workspace's dependencies
RUN npm ci --workspace=services/market-svc --production

# Copy shared module
COPY shared/ /app/shared/

# Copy service source
COPY services/market-svc/ /app/services/market-svc/

WORKDIR /app/services/market-svc
EXPOSE 3003
CMD ["node", "index.js"]
