#!/usr/bin/env bash
# 복구: deploy/restore.sh backups/db-YYYYMMDD-HHMM.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "${1:-}" ] || { echo "사용법: $0 <백업파일.sql.gz>"; exit 1; }
docker compose stop app
docker compose exec -T db psql -U dropship -d postgres -c "DROP DATABASE IF EXISTS dropship;" -c "CREATE DATABASE dropship OWNER dropship;"
gunzip -c "$1" | docker compose exec -T db psql -U dropship -d dropship
docker compose start app
echo "restore ok"
