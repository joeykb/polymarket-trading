FROM node:20-alpine AS base

# Build tools for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy shared module
COPY shared/ /app/shared/

# Copy and install dependencies
COPY services/data-svc/package.json services/data-svc/package-lock.json* ./services/data-svc/
WORKDIR /app/services/data-svc
RUN npm ci --production
RUN apk del python3 make g++

# Copy service source
COPY services/data-svc/ /app/services/data-svc/
RUN mkdir -p /app/output

EXPOSE 3005
CMD ["node", "index.js"]
