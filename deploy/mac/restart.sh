#!/usr/bin/env bash
# 앱 다시 시작(.env 를 고친 뒤 실행): bash ~/dropship/bin/restart.sh
. "$(dirname "$0")/common.sh"
app_restart
if healthy 60; then echo "✅ 다시 시작됨 (http://127.0.0.1:$(port))"; else echo "❌ 시작 확인 실패 — bash ~/dropship/bin/status.sh 로 로그를 확인하세요"; exit 1; fi
