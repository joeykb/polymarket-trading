FROM node:20-alpine

WORKDIR /app

# Copy shared module
COPY shared/ /app/shared/

# Copy and install dependencies
COPY services/market-svc/package.json services/market-svc/package-lock.json* ./services/market-svc/
WORKDIR /app/services/market-svc
RUN npm ci --production

# Copy service source
COPY services/market-svc/ /app/services/market-svc/

EXPOSE 3003
CMD ["node", "index.js"]
