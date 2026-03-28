FROM node:20-alpine

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./

# Copy service package.json for workspace resolution
COPY services/dashboard-svc/package.json ./services/dashboard-svc/

# Install only this workspace's dependencies
RUN npm ci --workspace=services/dashboard-svc --production \
    && npm cache clean --force

# Create non-root user
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup

# Copy shared module
COPY --chown=appuser:appgroup shared/ /app/shared/

# Copy service source
COPY --chown=appuser:appgroup services/dashboard-svc/ /app/services/dashboard-svc/

# Switch to non-root user
USER appuser

WORKDIR /app/services/dashboard-svc
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
