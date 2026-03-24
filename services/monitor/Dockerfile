FROM node:20-alpine

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./

# Copy service package.json for workspace resolution
COPY services/monitor/package.json ./services/monitor/

# Install only this workspace's dependencies
RUN npm ci --workspace=services/monitor --production

# Copy shared module
COPY shared/ /app/shared/

# Copy service source
COPY services/monitor/ /app/services/monitor/

WORKDIR /app/services/monitor
CMD ["node", "index.js"]
