#!/usr/bin/env bash
# 관리자 계정 생성/재설정: bash ~/dropship/bin/admin.sh <아이디> <비밀번호10자이상>
# (내장 DB는 한 프로세스만 열 수 있어 잠시 앱을 멈춘다)
. "$(dirname "$0")/common.sh"
[ $# -eq 2 ] || { echo "사용법: $0 <아이디> <비밀번호>"; exit 1; }
app_stop
( load_env; export DATA_DIR="$DATA"; cd "$APP/server" && "$NODE_BIN" dist/cli/create-admin.js "$1" "$2" ) || true
app_start
healthy 60 >/dev/null || echo "⚠ 앱 재시작 확인 필요"
