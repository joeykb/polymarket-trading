FROM node:20-alpine

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./

# Copy service package.json for workspace resolution
COPY services/weather-svc/package.json ./services/weather-svc/

# Install only this workspace's dependencies
RUN npm ci --workspace=services/weather-svc --production

# Copy shared module
COPY shared/ /app/shared/

# Copy service source
COPY services/weather-svc/ /app/services/weather-svc/

WORKDIR /app/services/weather-svc
EXPOSE 3002
CMD ["node", "index.js"]
