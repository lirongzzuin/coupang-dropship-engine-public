#!/usr/bin/env bash
# launchd 가 실행하는 앱 프로세스. 실행 중에는 Mac 잠자기를 막는다(caffeinate).
. "$(dirname "$0")/common.sh"
set -a; . "$ENV_FILE"; set +a
export DATA_DIR="$DATA" WEB_DIR="$APP/web/dist" NODE_ENV=production
cd "$APP/server"
exec /usr/bin/caffeinate -i -s "$NODE_BIN" dist/main.js
