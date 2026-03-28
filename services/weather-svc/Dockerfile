FROM node:20-alpine

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./

# Copy service package.json for workspace resolution
COPY services/weather-svc/package.json ./services/weather-svc/

# Install only this workspace's dependencies
RUN npm ci --workspace=services/weather-svc --production \
    && npm cache clean --force

# Create non-root user
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup

# Copy shared module
COPY --chown=appuser:appgroup shared/ /app/shared/

# Copy service source
COPY --chown=appuser:appgroup services/weather-svc/ /app/services/weather-svc/

# Switch to non-root user
USER appuser

WORKDIR /app/services/weather-svc
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3002/health || exit 1

CMD ["node", "index.js"]
