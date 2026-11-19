#!/usr/bin/env bash
set -euo pipefail

# Texas Capitol Ledger — Docker / CasaOS Safe Update Script
# Pulls the latest prebuilt image, checkpoints & backs up your SQLite database,
# restarts the container on the configured port, and verifies /api/health.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
ENV_FILE="$APP_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

PORT="${CAPITOL_PORT:-3089}"
DATA_DIR="${CAPITOL_DATA_DIR:-$APP_DIR/data}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
DB_FILE="$DATA_DIR/capitol_ledger.db"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.yml}"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "ERROR: Could not find $COMPOSE_FILE"
  echo "Run this script from your installed app directory (or set APP_DIR=/path/to/app)."
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose -f "$COMPOSE_FILE")
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose -f "$COMPOSE_FILE")
else
  echo "ERROR: Docker Compose is not installed."
  exit 1
fi

echo "==> Texas Capitol Ledger Update"
echo "    App directory : $APP_DIR"
echo "    Data directory: $DATA_DIR"
echo "    Target port   : $PORT"
echo ""

# 1. Pull new image BEFORE stopping the running container so downtime is minimal
#    and registry/auth failures never take your server offline.
echo "[1/5] Pulling latest container image..."
"${COMPOSE[@]}" pull

# 2. Gracefully stop container so server.ts runs PRAGMA wal_checkpoint(TRUNCATE)
echo "[2/5] Stopping container cleanly to flush SQLite WAL..."
"${COMPOSE[@]}" stop

# 3. Back up existing working database without ever modifying or overwriting it
echo "[3/5] Protecting existing SQLite database..."
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
LATEST_BACKUP=""
if [ -f "$DB_FILE" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  LATEST_BACKUP="$BACKUP_DIR/capitol_ledger-${STAMP}.db"
  cp -p "$DB_FILE" "$LATEST_BACKUP"
  echo "    Backup saved: $LATEST_BACKUP ($(du -h "$LATEST_BACKUP" | awk '{print $1}'))"

  # Rotate old backups, keeping the newest $KEEP_BACKUPS files
  ls -1t "$BACKUP_DIR"/capitol_ledger-*.db 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f --
else
  echo "    No existing capitol_ledger.db yet; container will initialize a new database on start."
fi

# 4. Recreate container on the same port with the existing persistent /app/data bind mount
echo "[4/5] Starting updated container on port $PORT..."
"${COMPOSE[@]}" up -d --remove-orphans

# 5. Wait for /api/health on the configured port
echo "[5/5] Verifying health endpoint (http://127.0.0.1:${PORT}/api/health)..."
HEALTHY=0
for _ in $(seq 1 30); do
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      HEALTHY=1
      break
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      HEALTHY=1
      break
    fi
  else
    if docker exec texas-capitol-ledger node -e "fetch('http://127.0.0.1:3089/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      HEALTHY=1
      break
    fi
  fi
  sleep 1
done

if [ "$HEALTHY" -eq 1 ]; then
  echo ""
  echo "Update complete! Texas Capitol Ledger is healthy on port $PORT."
  echo "Database preserved at: $DB_FILE"
  exit 0
else
  echo ""
  echo "WARNING: Health check did not respond within 30 seconds. Recent container logs:"
  "${COMPOSE[@]}" logs --tail=40
  if [ -n "$LATEST_BACKUP" ]; then
    echo ""
    echo "Your pre-update database backup is safe at: $LATEST_BACKUP"
  fi
  exit 1
fi
