#!/usr/bin/env bash
# 매일 04시 launchd 가 실행: 앱을 잠시 멈추고(내장 DB 일관성) data/ 를 압축 → 재시작
# 로컬 14일 보관 + iCloud Drive(있으면) 30일 보관. 로그 파일도 이때 정리.
. "$(dirname "$0")/common.sh"
mkdir -p "$BACKUPS"
F="$BACKUPS/data-$(date +%Y%m%d-%H%M).tgz"
app_stop
tar czf "$F" -C "$DROPSHIP_HOME" data
for f in "$LOGS"/*.log; do # 20MB 넘으면 회전
  [ -f "$f" ] && [ "$(stat -f%z "$f")" -gt 20971520 ] && mv "$f" "$f.1"
done
app_start
find "$BACKUPS" -name 'data-*.tgz' -mtime +14 -delete
ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
if [ -d "$ICLOUD" ] && [ "${DROPSHIP_ICLOUD_BACKUP:-1}" = "1" ]; then
  mkdir -p "$ICLOUD/dropship-backups" && cp "$F" "$ICLOUD/dropship-backups/"
  find "$ICLOUD/dropship-backups" -name 'data-*.tgz' -mtime +30 -delete
fi
healthy 60 || notify "🚨 [dropship] 백업 후 앱 재시작 실패 — 확인 필요"
log "백업 완료: $F ($(du -h "$F" | cut -f1))"
