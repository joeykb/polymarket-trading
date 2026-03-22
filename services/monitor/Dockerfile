FROM node:20-alpine

WORKDIR /app

# Copy shared module
COPY shared/ /app/shared/

# Copy service
COPY services/monitor/package.json services/monitor/package-lock.json* ./services/monitor/
WORKDIR /app/services/monitor
RUN npm ci --production

COPY services/monitor/ /app/services/monitor/

CMD ["node", "index.js"]
