#!/usr/bin/env bash
# 상태 확인: bash ~/dropship/bin/status.sh
. "$(dirname "$0")/common.sh"
echo "버전     : $(git -C "$APP" log -1 --format='%h %s (%cr)')"
for s in app updater backup; do
  st=$(launchctl print "$(svc $s)" 2>/dev/null | awk -F'= ' '/^\tstate/{print $2; exit}')
  echo "서비스   : $s ${st:-등록 안 됨}"
done
if curl -fs "http://127.0.0.1:$(port)/healthz" >/dev/null; then echo "헬스체크 : ✅ http://127.0.0.1:$(port)"; else echo "헬스체크 : ❌"; fi
echo "공인 IP  : $(curl -fs -m 5 https://api.ipify.org || echo 확인 실패)  ← 쿠팡 Wing 허용 IP와 같아야 함"
echo "최근 백업: $(ls -t "$BACKUPS"/data-*.tgz 2>/dev/null | head -1 || echo 없음)"
echo "업데이트 로그(최근):"; tail -3 "$LOGS/updater.log" 2>/dev/null || true
