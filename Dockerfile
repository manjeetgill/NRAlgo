# Broker-isolated numerical service. It has no Node dependencies, broker SDK or secrets.
FROM python:3.13-slim AS calculation
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY calculation_engine/requirements.lock ./calculation_engine/requirements.lock
RUN pip install --no-cache-dir --requirement calculation_engine/requirements.lock \
    && useradd --create-home --uid 10001 calculator
COPY --chown=calculator:calculator calculation_engine ./calculation_engine
USER calculator
EXPOSE 8010
CMD ["python", "-m", "uvicorn", "calculation_engine.worker:app", "--host", "0.0.0.0", "--port", "8010", "--workers", "1", "--limit-concurrency", "8", "--timeout-graceful-shutdown", "5", "--no-server-header"]

# Compile TypeScript with dev dependencies; production stages contain only runtime artifacts.
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
CMD ["node", "--import", "./dist/backend/runtime-secrets.js", "dist/backend/main.js"]

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

# Dedicated backup image: database/AWS tools are not installed in the API image.
FROM node:22-alpine AS backup
WORKDIR /app
RUN apk add --no-cache postgresql17-client aws-cli && mkdir /backups && chown node:node /backups
COPY --from=backend-build /app/dist/backend/backup.js ./dist/backend/backup.js
COPY --from=backend-build /app/dist/backend/runtime-secrets.js ./dist/backend/runtime-secrets.js
COPY package.json ./
USER node
CMD ["node", "--import", "./dist/backend/runtime-secrets.js", "dist/backend/backup.js"]
