#!/usr/bin/env bash
# 5분마다 launchd 가 실행: main 에서 "CI 를 통과한" 최신 커밋이 있으면 업데이트 → 헬스체크 → 실패 시 롤백
. "$(dirname "$0")/common.sh"
LOCK="$DROPSHIP_HOME/.update.lock"
mkdir "$LOCK" 2>/dev/null || { log "다른 업데이트 진행 중"; exit 0; }
trap 'rmdir "$LOCK"' EXIT

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  TARGET="$("$GH_BIN" run list -R "$REPO" --workflow ci-cd.yml --branch main --status success --limit 1 --json headSha --jq '.[0].headSha' 2>/dev/null || true)"
fi
[ -n "$TARGET" ] || { log "CI 통과 커밋을 찾지 못함(gh 인증/네트워크 확인)"; exit 0; }
CURRENT="$(git -C "$APP" rev-parse HEAD)"
[ "$TARGET" = "$CURRENT" ] && exit 0

log "업데이트 ${CURRENT:0:7} → ${TARGET:0:7}"
git -C "$APP" fetch --quiet origin
git -C "$APP" checkout --quiet --detach "$TARGET"
if ! bash "$BIN/build.sh"; then
  log "빌드 실패 → 롤백"
  git -C "$APP" checkout --quiet --detach "$CURRENT" && bash "$BIN/build.sh" || true
  notify "🚨 [dropship] 업데이트 빌드 실패(${TARGET:0:7}). 이전 버전 유지."
  exit 1
fi
install_scripts
app_restart
if healthy 90; then
  log "업데이트 완료 ${TARGET:0:7}"
  notify "✅ [dropship] 새 버전 배포 완료: ${TARGET:0:7} $(git -C "$APP" log -1 --format=%s | head -c 80)"
else
  log "헬스체크 실패 → 롤백 ${CURRENT:0:7}"
  git -C "$APP" checkout --quiet --detach "$CURRENT"
  bash "$BIN/build.sh" && app_restart && healthy 90 || true
  notify "🚨 [dropship] 새 버전(${TARGET:0:7}) 기동 실패 → 이전 버전(${CURRENT:0:7})으로 롤백"
  exit 1
fi
