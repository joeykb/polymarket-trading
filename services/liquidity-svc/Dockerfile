FROM node:20-alpine

WORKDIR /app

# Copy shared module
COPY shared/ /app/shared/

# Copy service
COPY services/liquidity-svc/package.json services/liquidity-svc/package-lock.json* ./services/liquidity-svc/
WORKDIR /app/services/liquidity-svc
RUN npm ci --production

COPY services/liquidity-svc/ /app/services/liquidity-svc/

EXPOSE 3001
CMD ["node", "index.js"]
