FROM node:20-alpine AS base

# Build tools for better-sqlite3 native compilation (combined layer)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy root workspace files for dependency resolution
COPY package.json package-lock.json ./

# Copy service package.json for workspace resolution
COPY services/data-svc/package.json ./services/data-svc/

# Install only data-svc workspace dependencies, then remove build tools
RUN npm ci --workspace=services/data-svc --production \
    && npm cache clean --force \
    && apk del python3 make g++

# Create non-root user
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001 -G appgroup

# Copy shared module
COPY --chown=appuser:appgroup shared/ /app/shared/

# Copy service source
COPY --chown=appuser:appgroup services/data-svc/ /app/services/data-svc/

# Create output directory with correct ownership
# storage.js resolves to path.resolve(__dirname, '../output') = /app/services/output
RUN mkdir -p /app/services/output && chown appuser:appgroup /app/services/output

# Switch to non-root user
USER appuser

WORKDIR /app/services/data-svc
EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3005/health || exit 1

CMD ["node", "index.js"]
