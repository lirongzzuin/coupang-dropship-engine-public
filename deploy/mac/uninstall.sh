#!/usr/bin/env bash
# 서비스 제거: bash ~/dropship/bin/uninstall.sh  (데이터까지 지우려면 --purge)
. "$(dirname "$0")/common.sh"
for s in app updater backup; do
  launchctl bootout "$(svc $s)" >/dev/null 2>&1 || true
  rm -f "$(plist $s)"
done
echo "서비스 제거 완료"
if [ "${1:-}" = "--purge" ]; then rm -rf "$DROPSHIP_HOME"; echo "데이터 삭제: $DROPSHIP_HOME"; else echo "데이터는 남겨둠: $DROPSHIP_HOME"; fi
