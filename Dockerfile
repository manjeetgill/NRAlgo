FROM node:22-alpine AS backend-build
WORKDIR /app
COPY package*.json ./
RUN npm ci --registry=https://registry.npmjs.org
COPY tsconfig.json run.ts ./
COPY backend ./backend
RUN npm run build:backend

FROM node:22-alpine AS backend
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0
COPY package*.json ./
RUN npm ci --omit=dev --registry=https://registry.npmjs.org
COPY --from=backend-build /app/dist/backend ./dist/backend
RUN mkdir /app/.runtime && chown node:node /app/.runtime
USER node
EXPOSE 8000
CMD ["node", "dist/backend/main.js"]

FROM node:22-alpine AS web-build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 API_URL=http://api:8000
COPY frontend/package*.json ./
RUN npm ci --registry=https://registry.npmjs.org
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=web-build --chown=node:node /app/.next/standalone ./
COPY --from=web-build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
