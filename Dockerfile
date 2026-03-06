# TempEdge - Polymarket NYC Temperature Predictor
# Multi-stage build for minimal image size

FROM node:20-alpine AS base

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies (none currently, but future-proof)
RUN npm install --production 2>/dev/null || true

# Copy source code
COPY src/ ./src/
COPY specs/ ./specs/

# Create output directory
RUN mkdir -p /app/output

# Default: run the monitor
CMD ["node", "src/monitor.js"]
