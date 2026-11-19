FROM node:22-bookworm-slim

WORKDIR /app

# Build tools for native better-sqlite3 if prebuilds aren't available on host arch
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* package-lock.json* ./
RUN npm install --no-audit --no-fund --legacy-peer-deps

COPY . .
RUN npm run build

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV CAPITOL_PORT=3089
ENV CAPITOL_DB_PATH=/app/data/capitol_ledger.db
ENV SKIP_SEED_ON_EXISTING_DB=true

EXPOSE 3089

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.CAPITOL_PORT || 3089) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
