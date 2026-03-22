FROM node:20-alpine

WORKDIR /app

# Copy shared module
COPY shared/ /app/shared/

# Copy and install dependencies
COPY services/weather-svc/package.json services/weather-svc/package-lock.json* ./services/weather-svc/
WORKDIR /app/services/weather-svc
RUN npm ci --production

# Copy service source
COPY services/weather-svc/ /app/services/weather-svc/

EXPOSE 3002
CMD ["node", "index.js"]
