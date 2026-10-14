#!/usr/bin/env bash
# 안전장치 상태 확인 / 판매 재개
#   bash ~/dropship/bin/resume-sales.sh status → 지금 판매 중지 여부와 남은 문제
#   bash ~/dropship/bin/resume-sales.sh        → 문제를 해결한 뒤 판매 재개(안전장치로 멈춘 상품만)
. "$(dirname "$0")/common.sh"
show() {
  local res; res="$(curl -s -m 30 "http://127.0.0.1:$(port)/healthz/safety")"
  [ -z "$res" ] && { echo "❌ 앱 응답 없음"; return 1; }
  RES="$res" "$NODE_BIN" -e '
    const r = JSON.parse(process.env.RES);
    console.log(r.halt ? `🛑 판매 중지 중 (${r.halt.by === "auto" ? "자동" : "수동"}, ${r.halt.at})\n   사유: ${r.halt.reason}` : "✅ 정상 판매 중");
    if (!r.issues.length) console.log("남은 문제 없음");
    for (const i of r.issues) console.log(`⚠️  ${i.message}\n   → ${i.fix}`);
  '
}
if [ "${1:-}" = "status" ]; then show; exit 0; fi
show || exit 1
printf "\n판매를 재개할까요? 문제를 해결하지 않았다면 %s시간 뒤 다시 자동 중지됩니다. (yes 입력): " "3"; read -r ans
[ "$ans" = "yes" ] || { echo "취소했습니다"; exit 0; }
res="$(curl -s -m 120 -X POST -H 'x-requested-with: app' "http://127.0.0.1:$(port)/healthz/safety/resume")"
echo "$res" | grep -q resumed && echo "✅ 판매 재개: $res" || { echo "❌ 실패: $res"; exit 1; }
