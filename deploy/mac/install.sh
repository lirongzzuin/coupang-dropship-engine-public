#!/usr/bin/env bash
# Mac 홈서버 설치(무료 운영). 이 Mac 에서 한 번만 실행:
#   bash deploy/mac/install.sh
# 하는 일: 코드 받기 → 빌드 → .env(비밀값 자동 생성) → launchd 서비스 3개 등록(앱·자동업데이트·백업) → 헬스체크
set -euo pipefail
[ "$(uname -s)" = "Darwin" ] || { echo "❌ macOS 전용입니다. 리눅스 서버는 deploy/setup-vps.sh 를 사용하세요."; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
export DROPSHIP_HOME="${DROPSHIP_HOME:-$HOME/dropship}"
. "$HERE/common.sh"

need() { command -v "$1" >/dev/null || { echo "❌ $1 이(가) 필요합니다. $2"; exit 1; }; }
need node "https://nodejs.org (24 LTS) 또는 brew install node@24"
need pnpm "corepack enable 또는 brew install pnpm"
need gh "brew install gh"
need git "xcode-select --install"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || { echo "❌ Node 22 이상 필요(현재 $(node -v))"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "❌ gh auth login 으로 GitHub 로그인 먼저(자동 업데이트에 사용)"; exit 1; }

mkdir -p "$DROPSHIP_HOME" "$DATA" "$LOGS" "$BACKUPS" "$BIN" "$AGENTS"
cat > "$RUNTIME" <<CONF
NODE_BIN="$(command -v node)"
PNPM_BIN="$(command -v pnpm)"
GH_BIN="$(command -v gh)"
EXTRA_PATH="$(dirname "$(command -v node)"):$(dirname "$(command -v pnpm)"):$(dirname "$(command -v gh)")"
CONF
. "$RUNTIME"

echo "▶ 코드 받기 → $APP"
if [ ! -d "$APP/.git" ]; then gh repo clone "$REPO" "$APP" -- --quiet; fi
git -C "$APP" fetch --quiet origin
SHA="$(gh run list -R "$REPO" --workflow ci-cd.yml --branch main --status success --limit 1 --json headSha --jq '.[0].headSha' 2>/dev/null || true)"
git -C "$APP" checkout --quiet --detach "${SHA:-origin/main}"
echo "  버전: $(git -C "$APP" log -1 --format='%h %s')"

echo "▶ 빌드"
install_scripts
bash "$BIN/build.sh" > "$LOGS/build.log" 2>&1 || { echo "❌ 빌드 실패 — $LOGS/build.log"; exit 1; }

if [ ! -f "$ENV_FILE" ]; then
  echo "▶ .env 생성(비밀값 자동 생성) → $ENV_FILE"
  umask 077
  cat > "$ENV_FILE" <<ENVEOF
# ── 서버 ─────────────────────────────────────────────
PORT=${PORT:-8080}
HOST=127.0.0.1
# 휴대폰 접속 주소(Tailscale Funnel 등 설정 후 https://... 로 바꾸기)
PUBLIC_BASE_URL=http://localhost:${PORT:-8080}
# 분실 시 고객정보 복호화 불가 — 비밀번호 관리자에 따로 보관
PII_KEY=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 16)

# ── 안전 플래그: 키 입력·점검 후 docs/runbook.md §3 순서로 켜기 ──
DRY_RUN=true
LIVE_LISTING=false
LIVE_PRICING=false
LIVE_FULFILLMENT=false
LIVE_ORDERING=false
LIVE_CS=false

# ── 쿠팡(키 입력 후 MARKET_ADAPTER=coupang) ─────────────
MARKET_ADAPTER=fake
COUPANG_VENDOR_ID=
COUPANG_ACCESS_KEY=
COUPANG_SECRET_KEY=

# ── 공급처·시장데이터·알림 ───────────────────────────────
OWNERCLAN_USERNAME=
OWNERCLAN_PASSWORD=
DOMEGGOOK_API_KEY=
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
NAVER_SEARCHAD_CUSTOMER_ID=
NAVER_SEARCHAD_API_KEY=
NAVER_SEARCHAD_SECRET=
# 네이버 데이터랩(검색어트렌드) 권한이 있는 앱이면 true (없으면 검색광고 검색량 추이로 대체)
NAVER_DATALAB_ENABLED=false
# 구글 트렌드 보조 지표(무료, 문제 생기면 false)
GOOGLE_TRENDS_ENABLED=true
# 쿠팡 파트너스 Open API(선택): 쿠팡 검색 상위 최저가·로켓배송 비율 → 가격 경쟁력 판단
COUPANG_PARTNERS_ACCESS_KEY=
COUPANG_PARTNERS_SECRET_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
# Mac 꺼짐 감시(healthchecks.io 무료 체크 주소, docs/deploy.md)
HEARTBEAT_URL=
LOG_LEVEL=info
ENVEOF
  umask 022
fi

echo "▶ launchd 서비스 등록"
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' <<<"$1"; }
write_plist() { # name, program, extra-xml
  cat > "$(plist "$1")" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$DROPSHIP_LABEL.$1</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$(xml "$BIN/$2")</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>DROPSHIP_HOME</key><string>$(xml "$DROPSHIP_HOME")</string>
    <key>DROPSHIP_LABEL</key><string>$DROPSHIP_LABEL</string>
    <key>DROPSHIP_REPO</key><string>$REPO</string>
  </dict>
  <key>StandardOutPath</key><string>$(xml "$LOGS/$1.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOGS/$1.log")</string>
  $3
</dict></plist>
PL
}
write_plist app run.sh '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>'
write_plist updater update.sh '<key>StartInterval</key><integer>300</integer>'
write_plist backup backup.sh '<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>'
for s in app updater backup; do
  launchctl bootout "$(svc $s)" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID_NUM" "$(plist $s)"
done

echo "▶ 기동 확인"
if healthy 90; then echo "  ✅ 실행 중: http://127.0.0.1:$(port)"; else echo "  ❌ 기동 실패 — $LOGS/app.log 확인"; exit 1; fi

cat <<MSG

✅ 설치 완료 (위치: $DROPSHIP_HOME)
다음 할 일:
 1) 관리자 만들기:   bash $BIN/admin.sh admin '비밀번호10자이상'   → 출력된 OTP 비밀키를 인증 앱에 등록
 2) 정전·재부팅 대비(1회, 관리자 암호 입력):
      sudo pmset -a sleep 0 disksleep 0 autorestart 1 womp 1
    시스템 설정 > 사용자 및 그룹 > 자동 로그인 켜기(재부팅 후 서비스 자동 시작)
 3) 휴대폰 접속(무료 HTTPS): Tailscale 설치 후  tailscale funnel --bg $(port)
    → 나온 https://….ts.net 주소를 $ENV_FILE 의 PUBLIC_BASE_URL 에 넣고:  bash $BIN/status.sh
 4) 공인 IP($(curl -fs -m 5 https://api.ipify.org || echo 확인 실패))를 쿠팡 Wing OPEN API 허용 IP에 등록
 5) $ENV_FILE 에 API 키 입력 → 앱 재시작:  launchctl kickstart -k $(svc app)

자동으로 돌아가는 것: 앱 상시 실행(죽으면 재시작) · 5분마다 GitHub main(CI 통과분) 자동 업데이트·롤백 · 매일 04시 백업(iCloud 사본)
상태 확인: bash $BIN/status.sh    제거: bash $BIN/uninstall.sh
MSG
