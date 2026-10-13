#!/usr/bin/env bash
# VPS에서 실행(GitHub Actions가 SSH로 호출): 새 이미지로 교체 → 헬스체크 → 실패 시 이전 이미지로 롤백
set -euo pipefail
cd "$(dirname "$0")/.."
: "${APP_IMAGE:?APP_IMAGE 필요}"
[ -f .env ] || { echo ".env 가 없습니다. deploy/setup-vps.sh 를 먼저 실행하세요."; exit 1; }

PREV=$(cat .deployed-image 2>/dev/null || true)
echo "▶ 배포: $APP_IMAGE (이전: ${PREV:-없음})"

# 배포 전 DB 백업(마이그레이션 대비)
if docker compose ps db --status running -q >/dev/null 2>&1 && [ -n "$(docker compose ps db --status running -q)" ]; then
  bash deploy/backup.sh || echo "⚠ 배포 전 백업 실패(계속 진행)"
fi

export APP_IMAGE
docker compose pull app
docker compose up -d --no-build --remove-orphans

healthy() {
  for i in $(seq 1 40); do
    if docker compose exec -T app node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then return 0; fi
    sleep 3
  done
  return 1
}

if healthy; then
  echo "$APP_IMAGE" > .deployed-image
  docker image prune -f >/dev/null
  echo "✅ 배포 성공"
else
  echo "❌ 헬스체크 실패 — 로그:"
  docker compose logs app --tail 80 || true
  if [ -n "$PREV" ]; then
    echo "↩ 롤백: $PREV"
    APP_IMAGE="$PREV" docker compose up -d --no-build app
  fi
  exit 1
fi
