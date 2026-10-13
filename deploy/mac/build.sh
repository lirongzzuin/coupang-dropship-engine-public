#!/usr/bin/env bash
# 현재 체크아웃된 코드로 의존성 설치 + 빌드
. "$(dirname "$0")/common.sh"
cd "$APP"
"$PNPM_BIN" install --frozen-lockfile --prefer-offline
"$PNPM_BIN" --filter web build
"$PNPM_BIN" --filter server build
