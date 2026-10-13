#!/usr/bin/env bash
# 상태 확인: bash ~/dropship/bin/status.sh
. "$(dirname "$0")/common.sh"
echo "버전     : $(git -C "$APP" log -1 --format='%h %s (%cr)')"
for s in app updater backup; do
  st=$(launchctl print "$(svc $s)" 2>/dev/null | awk -F'= ' '/^\tstate/{print $2; exit}')
  case "$s:${st:-}" in
    app:running) label="✅ 실행 중" ;;
    app:*) label="❌ ${st:-등록 안 됨}" ;;
    *:"") label="❌ 등록 안 됨" ;;
    *) label="✅ 등록됨(주기 실행 대기)" ;;
  esac
  echo "서비스   : $s $label"
done
# 재시작 직후일 수 있으므로 최대 20초 기다렸다가 판단
if healthy 20; then echo "헬스체크 : ✅ http://127.0.0.1:$(port)"; else echo "헬스체크 : ❌ (로그: tail -50 $LOGS/app.log)"; fi
if [ -z "$(env_get TELEGRAM_BOT_TOKEN)" ] || [ -z "$(env_get TELEGRAM_CHAT_ID)" ]; then echo "텔레그램 : ⚠ 미설정(.env 의 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)"; else echo "텔레그램 : ✅ 설정됨"; fi
# 자동 작업별 마지막 실행(이 Mac 안에서만 조회 가능)
jobs_json="$(curl -fs -m 10 "http://127.0.0.1:$(port)/healthz/jobs" 2>/dev/null || true)"
if [ -n "$jobs_json" ] && [ -n "${NODE_BIN:-}" ]; then
  echo "자동 작업(마지막 실행):"
  JOBS_JSON="$jobs_json" "$NODE_BIN" -e '
    const rows = JSON.parse(process.env.JOBS_JSON);
    const ago = (t) => { if (!t) return "아직 안 돌았음"; const m = Math.round((Date.now() - new Date(t)) / 60000); return m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`; };
    for (const r of rows) console.log(`  ${r.ok === null ? "⏳" : r.ok ? "✅" : "❌"} ${r.label.padEnd(18)} ${ago(r.at)}${r.ok === false && r.error ? " — " + r.error : ""}`);
  ' || true
fi
echo "공인 IP  : $(curl -fs -m 5 https://api.ipify.org || echo 확인 실패)  ← 쿠팡 Wing 허용 IP와 같아야 함"
echo "최근 백업: $(ls -t "$BACKUPS"/data-*.tgz 2>/dev/null | head -1 || echo 없음)"
echo "업데이트 로그(최근):"; tail -3 "$LOGS/updater.log" 2>/dev/null || true
