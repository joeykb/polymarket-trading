FROM node:20-alpine

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./

# Copy service package.json for workspace resolution
COPY services/market-svc/package.json ./services/market-svc/

# Install only this workspace's dependencies
RUN npm ci --workspace=services/market-svc --production \
    && npm cache clean --force

# Create non-root user
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup

# Copy shared module
COPY --chown=appuser:appgroup shared/ /app/shared/

# Copy service source
COPY --chown=appuser:appgroup services/market-svc/ /app/services/market-svc/

# Switch to non-root user
USER appuser

WORKDIR /app/services/market-svc
EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3003/health || exit 1

CMD ["node", "index.js"]
