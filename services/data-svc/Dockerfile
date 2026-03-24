FROM node:20-alpine AS base

# Build tools for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./

# Copy service package.json for workspace resolution
COPY services/data-svc/package.json ./services/data-svc/

# Install only data-svc workspace dependencies
RUN npm ci --workspace=services/data-svc --production
RUN apk del python3 make g++

# Copy shared module
COPY shared/ /app/shared/

# Copy service source
COPY services/data-svc/ /app/services/data-svc/
RUN mkdir -p /app/output

WORKDIR /app/services/data-svc
EXPOSE 3005
CMD ["node", "index.js"]
