# 배포 자동화 (deploy.md)

## 흐름
```
git push (main)
  └─ GitHub Actions: ci-cd
      1. test   : 타입체크 · 테스트 80개 · 웹 빌드
      2. image  : Docker 이미지 빌드 → 컨테이너 스모크 테스트(/healthz) → GHCR 푸시
                  ghcr.io/<계정>/coupang-dropship-engine:sha-<커밋> , :latest
      3. deploy : (DEPLOY_HOST 시크릿이 있을 때만) SSH → VPS
                  배포 전 DB 백업 → 새 이미지 pull·기동 → 헬스체크
                  실패 시 직전 이미지로 자동 롤백
```
- PR은 1~2단계만 실행합니다(이미지 푸시·배포 없음).
- DB 마이그레이션은 앱이 시작할 때 자동으로 적용됩니다.
- `deploy` 잡은 GitHub **Environment `production`**을 사용합니다. 레포 Settings > Environments > production에서 "Required reviewers"를 켜면 배포 전 승인 버튼을 받을 수 있습니다(선택).

## 최초 1회 설정

### 1) VPS 준비(서울 리전, Ubuntu)
```bash
# 레포의 스크립트를 서버에 복사한 뒤
sudo bash deploy/setup-vps.sh
```
이 스크립트가 하는 일:
- Docker 설치
- `deploy` 계정 생성
- 방화벽 설정(22·80·443)
- `/opt/dropship/.env` 생성(DB 비밀번호·PII_KEY·세션키 자동 생성)
- 매일 04시 백업 cron 등록

끝나면 아래를 직접 해 주세요:
- `/opt/dropship/.env`에 `DOMAIN`, `PUBLIC_BASE_URL`, API 키 입력
- 도메인 DNS A 레코드를 서버 IP로 지정. 같은 IP를 **쿠팡 Wing OPEN API 허용 IP**에도 등록

### 2) 배포용 SSH 키
```bash
ssh-keygen -t ed25519 -f deploy_key -N "" -C github-actions
# deploy_key.pub 내용을 서버 /home/deploy/.ssh/authorized_keys 에 추가
ssh-keyscan -H <서버IP>    # 출력값을 DEPLOY_KNOWN_HOSTS 시크릿으로(권장)
```

### 3) GitHub Secrets (레포 Settings > Secrets and variables > Actions)
| 이름 | 값 | 필수 |
|---|---|---|
| `DEPLOY_HOST` | 서버 IP 또는 도메인 | ✅ (없으면 배포를 건너뜀) |
| `DEPLOY_USER` | `deploy` | ✅ |
| `DEPLOY_SSH_KEY` | `deploy_key` **개인키** 전체 | ✅ |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan` 결과 | 권장(없으면 첫 접속 시 자동 수집) |
| `DEPLOY_PATH` | 기본 `/opt/dropship` | 선택 |

API 키·비밀값은 GitHub에 넣지 않습니다. 서버의 `.env`에만 둡니다.

### 4) 첫 배포
Actions > ci-cd > **Run workflow**를 누르거나 main에 push합니다. 배포가 끝나면 관리자 계정을 만듭니다.
```bash
cd /opt/dropship && docker compose exec app node dist/cli/create-admin.js admin '비밀번호'
```

## 운영 중
| 하고 싶은 일 | 방법 |
|---|---|
| 기능 수정 배포 | main에 push → 자동 |
| 특정 버전으로 되돌리기 | 서버에서 `APP_IMAGE=ghcr.io/<계정>/coupang-dropship-engine:sha-<커밋> bash deploy/remote-deploy.sh` (GHCR 로그인 필요) 또는 이전 커밋을 revert해서 push |
| 환경변수(키·플래그) 변경 | 서버 `.env` 수정 → `docker compose up -d` |
| 로그 | `docker compose logs app --tail 200 -f` |
| 백업·복구 | `docs/runbook.md` §4 |
