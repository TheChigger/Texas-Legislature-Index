#!/usr/bin/env bash
set -euo pipefail

# Texas Capitol Ledger — One-Step Docker / CasaOS Installer (x86_64)
# Usage:
#   bash deploy/install.sh
#   IMAGE=ghcr.io/myuser/myrepo:latest PORT=3089 bash deploy/install.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -d "/DATA/AppData" ]; then
  DEFAULT_APP_DIR="/DATA/AppData/texas-capitol-ledger"
else
  DEFAULT_APP_DIR="/opt/texas-capitol-ledger"
fi

APP_DIR="${APP_DIR:-$DEFAULT_APP_DIR}"
PORT="${PORT:-3089}"
IMAGE="${IMAGE:-}"
GEMINI_API_KEY="${GEMINI_API_KEY:-}"
EXISTING_DB="${EXISTING_DB:-}"

echo "=== Texas Capitol Ledger — Docker Installer ==="
echo ""

if [ -z "$IMAGE" ]; then
  read -r -p "GHCR Image (e.g. ghcr.io/username/repo:latest): " IMAGE
fi
IMAGE="$(echo "$IMAGE" | tr '[:upper:]' '[:lower:]' | xargs)"
if [ -z "$IMAGE" ]; then
  echo "ERROR: Docker image name is required."
  exit 1
fi

if [ -t 0 ]; then
  read -r -p "Install directory [$APP_DIR]: " INPUT_DIR
  APP_DIR="${INPUT_DIR:-$APP_DIR}"

  read -r -p "Host port [$PORT]: " INPUT_PORT
  PORT="${INPUT_PORT:-$PORT}"

  if [ -z "$GEMINI_API_KEY" ]; then
    read -r -p "Optional GEMINI_API_KEY (press Enter to skip): " GEMINI_API_KEY
  fi

  if [ ! -f "$APP_DIR/data/capitol_ledger.db" ] && [ -z "$EXISTING_DB" ]; then
    read -r -p "Optional path to an existing capitol_ledger.db to import (press Enter to skip): " EXISTING_DB
  fi
fi

mkdir -p "$APP_DIR/data" "$APP_DIR/backups"

# Safely import an existing database ONLY if one does not already exist in $APP_DIR/data
if [ -n "$EXISTING_DB" ]; then
  if [ -f "$APP_DIR/data/capitol_ledger.db" ]; then
    echo "Existing database found at $APP_DIR/data/capitol_ledger.db — refusing to overwrite."
  elif [ -f "$EXISTING_DB" ]; then
    cp -p "$EXISTING_DB" "$APP_DIR/data/capitol_ledger.db"
    echo "Imported existing database to $APP_DIR/data/capitol_ledger.db"
  else
    echo "WARNING: Existing DB path not found: $EXISTING_DB (continuing without import)"
  fi
fi

cat > "$APP_DIR/.env" <<EOF
CAPITOL_IMAGE=$IMAGE
CAPITOL_PORT=$PORT
CAPITOL_DATA_DIR=$APP_DIR/data
GEMINI_API_KEY=$GEMINI_API_KEY
EOF
chmod 600 "$APP_DIR/.env"

cat > "$APP_DIR/docker-compose.yml" <<'EOF'
name: texas-capitol-ledger
services:
  texas-capitol-ledger:
    image: ${CAPITOL_IMAGE}
    container_name: texas-capitol-ledger
    restart: unless-stopped
    ports:
      - "${CAPITOL_PORT:-3089}:3089"
    environment:
      NODE_ENV: production
      CAPITOL_PORT: "3089"
      CAPITOL_DB_PATH: /app/data/capitol_ledger.db
      SKIP_SEED_ON_EXISTING_DB: "true"
      GEMINI_API_KEY: "${GEMINI_API_KEY:-}"
    volumes:
      - ./data:/app/data
EOF

if [ -f "$SCRIPT_DIR/update.sh" ]; then
  cp "$SCRIPT_DIR/update.sh" "$APP_DIR/update.sh"
  chmod +x "$APP_DIR/update.sh"
fi

echo ""
echo "Installed configuration in $APP_DIR"
echo "Running initial pull & startup via $APP_DIR/update.sh..."
echo ""

if [ -x "$APP_DIR/update.sh" ]; then
  APP_DIR="$APP_DIR" "$APP_DIR/update.sh"
else
  docker compose -f "$APP_DIR/docker-compose.yml" pull
  docker compose -f "$APP_DIR/docker-compose.yml" up -d
fi

echo ""
echo "Future updates: run '$APP_DIR/update.sh' (or click 'Check and Update' in CasaOS)."
