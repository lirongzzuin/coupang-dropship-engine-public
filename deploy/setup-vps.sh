#!/usr/bin/env bash
# VPS 최초 1회 설정(Ubuntu 22.04/24.04, root 로 실행):
#   curl -fsSL https://raw.githubusercontent.com/<계정>/<레포>/main/deploy/setup-vps.sh | sudo bash
# 또는 레포 파일을 복사해 sudo bash deploy/setup-vps.sh
set -euo pipefail
DEPLOY_USER=${DEPLOY_USER:-deploy}
DEPLOY_PATH=${DEPLOY_PATH:-/opt/dropship}

echo "▶ Docker 설치"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi

echo "▶ 배포 계정($DEPLOY_USER) 생성"
id "$DEPLOY_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
mkdir -p "/home/$DEPLOY_USER/.ssh" && chmod 700 "/home/$DEPLOY_USER/.ssh"
touch "/home/$DEPLOY_USER/.ssh/authorized_keys" && chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"

echo "▶ 배포 폴더 $DEPLOY_PATH"
mkdir -p "$DEPLOY_PATH/deploy" "$DEPLOY_PATH/backups"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_PATH"

echo "▶ 방화벽(22, 80, 443)"
if command -v ufw >/dev/null; then ufw allow OpenSSH; ufw allow 80/tcp; ufw allow 443/tcp; ufw --force enable; fi

echo "▶ 비밀값이 채워진 .env 생성"
ENV="$DEPLOY_PATH/.env"
if [ ! -f "$ENV" ]; then
  cat > "$ENV" <<ENVEOF
DOMAIN=
PUBLIC_BASE_URL=
POSTGRES_PASSWORD=$(openssl rand -hex 24)
PII_KEY=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 16)
DRY_RUN=true
LIVE_LISTING=false
LIVE_PRICING=false
LIVE_FULFILLMENT=false
LIVE_ORDERING=false
LIVE_CS=false
MARKET_ADAPTER=fake
COUPANG_VENDOR_ID=
COUPANG_ACCESS_KEY=
COUPANG_SECRET_KEY=
OWNERCLAN_USERNAME=
OWNERCLAN_PASSWORD=
DOMEGGOOK_API_KEY=
NAVER_CLIENT_ID=
NAVER_CLIENT_SECRET=
NAVER_SEARCHAD_CUSTOMER_ID=
NAVER_SEARCHAD_API_KEY=
NAVER_SEARCHAD_SECRET=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
LOG_LEVEL=info
ENVEOF
  chmod 600 "$ENV"; chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV"
fi

echo "▶ 매일 04시 백업 cron"
( crontab -u "$DEPLOY_USER" -l 2>/dev/null | grep -v backup.sh; echo "0 4 * * * cd $DEPLOY_PATH && bash deploy/backup.sh >> backups/backup.log 2>&1" ) | crontab -u "$DEPLOY_USER" -

IP=$(curl -fs https://api.ipify.org || echo '확인 실패')
cat <<MSG

✅ 완료. 남은 작업:
 1) $ENV 편집: DOMAIN·PUBLIC_BASE_URL(https://도메인)·API 키 입력
    (PII_KEY 는 따로 안전하게 보관 — 분실 시 고객정보 복호화 불가)
 2) 도메인 DNS A 레코드 → 이 서버 IP: $IP   (쿠팡 Wing OPEN API 허용 IP에도 등록)
 3) GitHub 레포 Settings > Secrets 에 DEPLOY_HOST=$IP, DEPLOY_USER=$DEPLOY_USER, DEPLOY_SSH_KEY 등록,
    그 공개키를 /home/$DEPLOY_USER/.ssh/authorized_keys 에 추가
 4) main 에 push 하거나 Actions > ci-cd > Run workflow → 자동 배포
 5) 관리자 생성: cd $DEPLOY_PATH && docker compose exec app node dist/cli/create-admin.js admin '비밀번호'
MSG
