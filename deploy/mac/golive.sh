#!/usr/bin/env bash
# 실전 전환 스위치 (.env 를 직접 고치지 않아도 됨)
#   bash ~/dropship/bin/golive.sh check   → 준비 상태만 점검(아무것도 바꾸지 않음)
#   bash ~/dropship/bin/golive.sh         → 점검 + 쿠팡 등록 사전 점검 → 확인 후 실전 전환(자동 등록·주문 처리·자동 발주·가격/재고·문의 답변)
#   bash ~/dropship/bin/golive.sh off     → 모의 실행으로 되돌리기(외부 부작용 전부 중지)
. "$(dirname "$0")/common.sh"
MODE="${1:-on}"

env_set() { # KEY VALUE — 있으면 교체(공백·따옴표 무관), 없으면 추가
  ENV_PATH="$ENV_FILE" K="$1" V="$2" "$NODE_BIN" -e '
    const fs = require("fs"); const p = process.env.ENV_PATH, k = process.env.K, v = process.env.V;
    const lines = fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n") : [];
    const re = new RegExp("^\\s*" + k + "\\s*=");
    let found = false;
    const out = lines.map((l) => (re.test(l) ? ((found = true), `${k}=${v}`) : l));
    if (!found) { if (out.length && out[out.length - 1] === "") out.pop(); out.push(`${k}=${v}`, ""); }
    fs.writeFileSync(p, out.join("\n"));
  '
}

readiness() {
  local res
  res="$(curl -s -m 120 "http://127.0.0.1:$(port)/healthz/golive")"
  [ -z "$res" ] && { echo "❌ 앱 응답 없음 — bash ~/dropship/bin/restart.sh 후 다시 실행"; return 1; }
  RES="$res" "$NODE_BIN" -e '
    const r = JSON.parse(process.env.RES);
    for (const i of r.items) console.log(`${i.ok ? "✅" : i.critical ? "❌" : "⚠️ "} ${i.name}: ${i.detail}`);
    console.log(r.ok ? "\n준비 완료" : "\n❌ 위 ❌ 항목을 먼저 해결하세요");
    process.exit(r.ok ? 0 : 1);
  '
}

case "$MODE" in
  check)
    echo "실전 준비 점검 중… (최대 1분)"; readiness ;;
  off)
    cp "$ENV_FILE" "$BACKUPS/env.$(date +%Y%m%d-%H%M%S).bak"
    env_set DRY_RUN true
    app_restart
    healthy 60 && echo "✅ 모의 실행으로 되돌림(쿠팡·오너클랜에 아무것도 보내지 않음). 이미 쿠팡에 올라간 상품은 Wing에서 판매중지하세요." ;;
  on)
    echo "1/3 실전 준비 점검 중… (최대 1분)"
    readiness || exit 1
    echo; echo "2/3 쿠팡 등록 사전 점검 중… (임시저장 후 삭제, 1~2분)"
    out="$(mktemp)"
    bash "$BIN/verify-listing.sh" | tee "$out" || true
    if ! grep -q "✅ 등록 가능" "$out"; then
      rm -f "$out"
      echo "❌ 쿠팡 사전 점검 실패 — 위 메시지를 확인하세요(후보가 없으면 내일 다시 실행)"; exit 1
    fi
    rm -f "$out"
    echo
    echo "3/3 실전 전환: 이제부터 실제로"
    echo "  - 쿠팡에 상품이 자동 등록되고(하루 최대 3개) 가격·재고·판매중지가 반영됩니다"
    echo "  - 주문이 오면 상품준비중 처리 → 오너클랜 자동 발주(예치금 결제) → 송장 자동 등록"
    echo "  - 배송 문의는 템플릿으로 자동 답변합니다"
    printf "계속하려면 yes 입력: "; read -r ans
    [ "$ans" = "yes" ] || { echo "취소했습니다(바뀐 것 없음)"; exit 0; }
    mkdir -p "$BACKUPS"; cp "$ENV_FILE" "$BACKUPS/env.$(date +%Y%m%d-%H%M%S).bak"
    for k in LIVE_LISTING LIVE_FULFILLMENT LIVE_ORDERING LIVE_PRICING LIVE_CS; do env_set "$k" true; done
    env_set DRY_RUN false
    app_restart
    if healthy 60; then
      echo "✅ 실전 전환 완료. 텔레그램으로 등록·주문 알림이 옵니다."
      echo "   되돌리기: bash ~/dropship/bin/golive.sh off   /  급할 때: 관리 화면 [긴급 정지]"
      notify "🚀 실전 전환: 자동 등록·주문 처리·자동 발주가 켜졌습니다." || true
    else
      echo "❌ 다시 시작 확인 실패 — bash ~/dropship/bin/status.sh"; exit 1
    fi ;;
  *) echo "사용법: golive.sh [check|off]"; exit 1 ;;
esac
