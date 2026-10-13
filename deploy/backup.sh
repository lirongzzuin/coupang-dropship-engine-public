#!/usr/bin/env bash
# 매일 DB 백업(크론: 0 4 * * * /opt/dropship/deploy/backup.sh)
# 보관: 로컬 14일. RCLONE_REMOTE 가 있으면 오브젝트 스토리지(R2/S3)로도 업로드
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=${BACKUP_DIR:-./backups}
mkdir -p "$DIR"
F="$DIR/db-$(date +%Y%m%d-%H%M).sql.gz"
docker compose exec -T db pg_dump -U dropship dropship | gzip > "$F"
docker compose cp app:/data/media "$DIR/media" >/dev/null 2>&1 || true
find "$DIR" -name 'db-*.sql.gz' -mtime +14 -delete
if [ -n "${RCLONE_REMOTE:-}" ]; then rclone copy "$F" "$RCLONE_REMOTE"; rclone sync "$DIR/media" "$RCLONE_REMOTE/media"; fi
echo "backup ok: $F"
