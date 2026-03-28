FROM node:20-alpine AS base

# Build tools for ethers native deps (combined layer to reduce image size)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./

# Copy service package.json for workspace resolution
COPY services/trading-svc/package.json ./services/trading-svc/

# Install only this workspace's dependencies, then remove build tools in same layer
RUN npm ci --workspace=services/trading-svc --production \
    && npm cache clean --force \
    && apk del python3 make g++

# Create non-root user
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup

# Copy shared module
COPY --chown=appuser:appgroup shared/ /app/shared/

# Copy service source
COPY --chown=appuser:appgroup services/trading-svc/ /app/services/trading-svc/

# Copy redeem script (used by K8s CronJob)
COPY --chown=appuser:appgroup src/scripts/redeem.js /app/src/scripts/redeem.js

# Install dotenv at app root for the redeem script
RUN cd /app && npm install dotenv@16 --no-save 2>/dev/null || true

# Switch to non-root user
USER appuser

WORKDIR /app/services/trading-svc
EXPOSE 3004

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3004/health || exit 1

CMD ["node", "index.js"]
