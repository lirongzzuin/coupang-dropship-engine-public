#!/usr/bin/env bash
# 연결 점검: .env 의 키로 각 서비스에 실제 조회(쓰기 없음) → ✅/❌/⬜
#   bash ~/dropship/bin/check.sh
. "$(dirname "$0")/common.sh"
load_env
cd "$APP/server" && "$NODE_BIN" dist/cli/check.js
