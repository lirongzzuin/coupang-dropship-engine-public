#!/usr/bin/env bash
# 쿠팡 등록 사전 점검: 상위 후보 1개를 쿠팡에 "임시저장"(심사 요청 안 함, 고객에게 안 보임)으로 보내
# 쿠팡이 받아주는지 확인하고 바로 삭제합니다. 실제 등록(LIVE_LISTING)을 켜기 전에 한 번 실행하세요.
. "$(dirname "$0")/common.sh"
echo "점검 중… (이미지 변환 포함 1~2분)"
res="$(curl -s -m 300 -X POST -H 'x-requested-with: app' "http://127.0.0.1:$(port)/healthz/verify-listing")"
[ -z "$res" ] && { echo "❌ 앱 응답 없음"; exit 1; }
RES="$res" "$NODE_BIN" -e '
  const r = JSON.parse(process.env.RES);
  console.log(r.ok ? "✅ 등록 가능" : "❌ 등록 불가");
  if (r.title) console.log("  상품   :", r.title);
  if (r.category) console.log("  카테고리:", r.category);
  if (r.attributes) console.log("  필수옵션:", r.attributes.map((a) => a.attributeTypeName + "=" + a.attributeValueName).join(", "));
  console.log("  결과   :", r.message);
'
