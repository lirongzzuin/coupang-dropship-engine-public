#!/usr/bin/env bash
# 자동 작업 지금 바로 실행: bash ~/dropship/bin/run-job.sh selection.run
#   작업 이름: orders.poll  keywords.discover  selection.run  listings.sync  profit.optimize  report.daily ...
. "$(dirname "$0")/common.sh"
[ $# -eq 1 ] || { echo "사용법: $0 <작업이름>  (예: selection.run)"; exit 1; }
res="$(curl -s -m 10 -X POST -H 'x-requested-with: app' "http://127.0.0.1:$(port)/healthz/jobs/$1/run")"
case "$res" in *started*) echo "✅ '$1' 시작 — 결과는 텔레그램 또는 status.sh 로 확인";; *) echo "❌ 실행 실패: ${res:-앱 응답 없음}";; esac
