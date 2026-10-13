#!/usr/bin/env bash
# 복구: bash ~/dropship/bin/restore.sh ~/dropship/backups/data-YYYYMMDD-HHMM.tgz
. "$(dirname "$0")/common.sh"
[ -f "${1:-}" ] || { echo "사용법: $0 <백업파일.tgz>"; exit 1; }
app_stop
[ -d "$DATA" ] && mv "$DATA" "$DATA.before-restore-$(date +%Y%m%d%H%M%S)"
tar xzf "$1" -C "$DROPSHIP_HOME"
app_start
healthy 60 && echo "✅ 복구 완료" || { echo "❌ 기동 실패 — logs/app.log 확인"; exit 1; }
