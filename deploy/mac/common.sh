#!/usr/bin/env bash
# 공통 설정 — 다른 스크립트가 source 한다.
# 위치(기본 ~/dropship):  app/ 코드  data/ DB·이미지  backups/  logs/  bin/ 스크립트  .env 비밀값
set -euo pipefail
export DROPSHIP_HOME="${DROPSHIP_HOME:-$HOME/dropship}"
export DROPSHIP_LABEL="${DROPSHIP_LABEL:-com.dropship}"
export REPO="${DROPSHIP_REPO:-lirongzzuin/coupang-dropship-engine-public}"
APP="$DROPSHIP_HOME/app"
DATA="$DROPSHIP_HOME/data"
LOGS="$DROPSHIP_HOME/logs"
BACKUPS="$DROPSHIP_HOME/backups"
BIN="$DROPSHIP_HOME/bin"
ENV_FILE="$DROPSHIP_HOME/.env"
RUNTIME="$DROPSHIP_HOME/runtime.conf"
AGENTS="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"
# launchd 는 PATH 가 최소라 설치 시 절대경로를 runtime.conf 에 저장해 둔다
[ -f "$RUNTIME" ] && . "$RUNTIME"
export PATH="${EXTRA_PATH:+$EXTRA_PATH:}${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

env_get() { # .env 에서 값 읽기
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'
}

load_env() { # .env 를 안전하게 읽기: '=' 앞뒤 공백·양끝 따옴표·줄끝 공백(CR) 무시, 명령으로 실행하지 않음
  [ -f "$ENV_FILE" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    val="${val#"${val%%[![:space:]]*}"}"; val="${val%"${val##*[![:space:]]}"}"
    if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    export "$key=$val"
  done < "$ENV_FILE"
}

port() { local p; p="$(env_get PORT)"; echo "${p:-8080}"; }

healthy() { # 최대 $1초 동안 /healthz 확인
  local t="${1:-60}" i=0
  while [ "$i" -lt "$t" ]; do
    curl -fs "http://127.0.0.1:$(port)/healthz" >/dev/null 2>&1 && return 0
    sleep 2; i=$((i + 2))
  done
  return 1
}

svc() { echo "gui/$UID_NUM/$DROPSHIP_LABEL.$1"; }
plist() { echo "$AGENTS/$DROPSHIP_LABEL.$1.plist"; }

app_stop() { launchctl bootout "$(svc app)" >/dev/null 2>&1 || true; sleep 1; }
app_start() { launchctl bootstrap "gui/$UID_NUM" "$(plist app)" >/dev/null 2>&1 || launchctl kickstart -k "$(svc app)" >/dev/null 2>&1 || true; }
app_restart() { launchctl kickstart -k "$(svc app)" >/dev/null 2>&1 || app_start; }

notify() { # 텔레그램 알림(설정돼 있을 때만)
  local token chat
  token="$(env_get TELEGRAM_BOT_TOKEN)"; chat="$(env_get TELEGRAM_CHAT_ID)"
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  curl -fs -m 10 -X POST "https://api.telegram.org/bot$token/sendMessage" \
    --data-urlencode "chat_id=$chat" --data-urlencode "text=$1" >/dev/null 2>&1 || true
}

# 스크립트를 bin/ 으로 원자적으로 교체(실행 중인 스크립트가 깨지지 않도록 mv 사용)
install_scripts() {
  mkdir -p "$BIN"
  for f in "$APP"/deploy/mac/*.sh; do
    [ -f "$f" ] || continue
    cp "$f" "$BIN/.$(basename "$f").new" && chmod +x "$BIN/.$(basename "$f").new" && mv -f "$BIN/.$(basename "$f").new" "$BIN/$(basename "$f")"
  done
}
