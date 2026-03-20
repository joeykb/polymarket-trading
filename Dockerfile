# TempEdge - Polymarket Temperature Predictor
# Alpine build with native SQLite support

FROM node:20-alpine AS base

# Install build tools for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files and install
COPY package.json package-lock.json ./
RUN npm ci --production

# Remove build tools to shrink image
RUN apk del python3 make g++

# Copy source code
COPY src/ ./src/
COPY specs/ ./specs/

# Create output directory
RUN mkdir -p /app/output

# Default: run the monitor
CMD ["node", "src/monitor.js"]
