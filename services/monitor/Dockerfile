FROM node:20-alpine

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./

# Copy service package.json for workspace resolution
COPY services/monitor/package.json ./services/monitor/

# Install only this workspace's dependencies
RUN npm ci --workspace=services/monitor --production \
    && npm cache clean --force

# Create non-root user
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup

# Copy shared module
COPY --chown=appuser:appgroup shared/ /app/shared/

# Copy service source
COPY --chown=appuser:appgroup services/monitor/ /app/services/monitor/

# Switch to non-root user
USER appuser

WORKDIR /app/services/monitor

CMD ["node", "index.js"]
