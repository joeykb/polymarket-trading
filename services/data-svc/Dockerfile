FROM node:20-alpine AS base

# Build tools for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production
RUN apk del python3 make g++

COPY . .
RUN mkdir -p /app/output

EXPOSE 3005

CMD ["node", "index.js"]
