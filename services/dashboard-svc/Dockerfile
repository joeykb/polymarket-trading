FROM node:20-alpine

WORKDIR /app

# Copy shared module
COPY shared/ /app/shared/

# Copy service
COPY services/dashboard-svc/package.json services/dashboard-svc/package-lock.json* ./services/dashboard-svc/
WORKDIR /app/services/dashboard-svc
RUN npm ci --production

COPY services/dashboard-svc/ /app/services/dashboard-svc/

EXPOSE 3000
CMD ["node", "server.js"]
