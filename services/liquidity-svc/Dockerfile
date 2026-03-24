FROM node:20-alpine

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./

# Copy service package.json for workspace resolution
COPY services/liquidity-svc/package.json ./services/liquidity-svc/

# Install only this workspace's dependencies
RUN npm ci --workspace=services/liquidity-svc --production

# Copy shared module
COPY shared/ /app/shared/

# Copy service source
COPY services/liquidity-svc/ /app/services/liquidity-svc/

WORKDIR /app/services/liquidity-svc
EXPOSE 3001
CMD ["node", "index.js"]
