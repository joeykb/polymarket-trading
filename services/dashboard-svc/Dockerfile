FROM node:20-alpine

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./

# Copy service package.json for workspace resolution
COPY services/dashboard-svc/package.json ./services/dashboard-svc/

# Install only this workspace's dependencies
RUN npm ci --workspace=services/dashboard-svc --production

# Copy shared module
COPY shared/ /app/shared/

# Copy service source
COPY services/dashboard-svc/ /app/services/dashboard-svc/

WORKDIR /app/services/dashboard-svc
EXPOSE 3000
CMD ["node", "server.js"]
