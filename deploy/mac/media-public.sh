#!/usr/bin/env bash
# 상품 이미지(/media)만 인터넷에 공개 — 쿠팡이 상품 이미지를 내려받을 수 있게.
# 관리 화면(/)은 그대로 내 기기(tailnet)에서만 접속됩니다.
#   켜기:  bash ~/dropship/bin/media-public.sh
#   끄기:  bash ~/dropship/bin/media-public.sh off
. "$(dirname "$0")/common.sh"

TS="$(command -v tailscale || true)"
[ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -z "$TS" ] && { echo "❌ Tailscale 이 설치되어 있지 않습니다."; exit 1; }
MEDIA_PORT=8443

env_set() { # .env 의 KEY=값 교체(없으면 추가)
  if grep -qE "^$1=" "$ENV_FILE"; then
    local tmp; tmp="$(mktemp)"; grep -vE "^$1=" "$ENV_FILE" > "$tmp"; echo "$1=$2" >> "$tmp"; cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  else
    echo "$1=$2" >> "$ENV_FILE"
  fi
}

if [ "${1:-on}" = "off" ]; then
  "$TS" funnel --https=$MEDIA_PORT off >/dev/null 2>&1 || true
  env_set MEDIA_PUBLIC_BASE_URL ""
  app_restart
  echo "✅ 이미지 공개를 껐습니다."
  exit 0
fi

HOST="$("$TS" status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)"
[ -z "$HOST" ] && { echo "❌ Tailscale 에 로그인되어 있지 않습니다(메뉴바 Tailscale 아이콘 → Log in)."; exit 1; }

if ! "$TS" funnel --bg --https=$MEDIA_PORT --set-path=/media "http://127.0.0.1:$(port)/media" 2>&1; then
  echo "❌ Funnel 을 켜지 못했습니다. 위 안내 링크가 나오면 브라우저로 열어 Funnel 을 허용한 뒤 다시 실행하세요."
  exit 1
fi
BASE="https://$HOST:$MEDIA_PORT"
env_set MEDIA_PUBLIC_BASE_URL "$BASE"
app_restart
healthy 30 || true

# 공개 확인: 없는 파일은 404 가 정상(관리 화면은 이 주소로 열리지 않아야 함)
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/media/__check__.jpg" || true)"
admin="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE/" || true)"
echo "이미지 공개 주소: $BASE/media/…"
if [ "$code" = "404" ]; then echo "✅ 이미지 주소 응답 정상"; else echo "⚠️ 이미지 주소 응답 $code (몇 분 뒤 다시 실행해 보세요 — 인증서 발급 중일 수 있음)"; fi
if [ "$admin" = "404" ] || [ "$admin" = "000" ] || [ "$admin" = "502" ]; then echo "✅ 관리 화면은 공개되지 않음"; else echo "⚠️ 관리 화면 응답 $admin — 확인 필요"; fi
