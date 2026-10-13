# 배포·운영 환경 (deploy.md)

## 결론: **무료 — 지금 쓰는 Mac(mini)을 홈서버로**

| 선택지 | 비용 | 판단 |
|---|---|---|
| **Mac 홈서버(권장)** | 0원(전기료 월 수백 원 수준) | 이 앱은 가볍습니다(메모리 약 150MB, CPU 대부분 대기). 내장 Postgres(PGlite)를 써서 Docker도 필요 없습니다. 쿠팡 API 허용 IP에는 집 공인 IP를 등록하고, IP가 바뀌면 시스템이 감지해 알려 줍니다 |
| Oracle Cloud Always Free(춘천/서울) | 0원 | 고정 IP를 주는 평생 무료 VM입니다. `deploy/setup-vps.sh`와 Docker 구성을 그대로 쓸 수 있습니다. 다만 가입 시 카드 인증이 필요하고, 무료 자원이 부족해 생성이 실패하는 경우가 있습니다 |
| Vercel·Cloudflare Workers·Render 등 | 무료 | ❌ 나가는 IP가 고정되지 않아 쿠팡 허용 IP로 등록할 수 없습니다. Render 무료는 15분 뒤 잠들어 주문 수집이 끊깁니다 |

> 쿠팡 OPEN API는 Wing에 등록한 IP(키당 최대 10개)에서만 호출됩니다. IP를 등록하거나 바꾼 뒤 반영까지 최대 30분이 걸립니다(`docs/research.md` §2-1).

---

## A. Mac 홈서버 (권장, 무료)

### 설치(이 Mac에서 1회)
```bash
cd ~/coupang-dropship-engine
bash deploy/mac/install.sh
```
설치하는 것(`~/dropship`):

| 자동으로 도는 것 | 방식 |
|---|---|
| 앱 상시 실행 | launchd. 부팅 시 시작, 죽으면 1초 안에 재시작, 실행 중에는 잠자기 방지(caffeinate) |
| 자동 업데이트 | 5분마다 GitHub main에서 **CI(테스트)를 통과한** 최신 커밋을 확인 → 빌드 → 재시작 → 헬스체크 → **실패하면 이전 버전으로 자동 롤백** → 텔레그램 알림 |
| 백업 | 매일 04시 `data/`를 압축해 로컬 14일, iCloud Drive 30일 보관. 로그 정리 포함 |
| 공인 IP 감시 | 10분마다 확인 → 바뀌면 "Wing에 새 IP 등록" 알림. 대시보드에도 표시 |

`.env`의 비밀값(PII_KEY, 세션키)은 설치할 때 자동으로 생성됩니다. 처음에는 **모의 실행(DRY_RUN) + 가짜 쿠팡**으로 시작합니다.

### 설치 후 할 일
1. **관리자 계정**: `bash ~/dropship/bin/admin.sh admin '비밀번호10자이상'` → 출력된 OTP 비밀키를 인증 앱(Google Authenticator 등)에 등록
2. **꺼지지 않게(1회)**
   - `sudo pmset -a sleep 0 disksleep 0 autorestart 1 womp 1` (잠자기 끔, 정전 후 자동 부팅)
   - 시스템 설정 > 사용자 및 그룹 > **자동 로그인** 켜기(재부팅 후 서비스가 사용자 세션에서 자동 시작)
3. **휴대폰 접속(무료 HTTPS, 도메인 불필요)**: [Tailscale](https://tailscale.com) 설치·로그인(Mac과 휴대폰 모두)
   - 내 기기에서만 접속(가장 안전): `tailscale serve --bg 8080`
   - 직접 찍은 상품 이미지를 올려 쿠팡이 내려받아야 할 때: `tailscale funnel --bg 8080` (인터넷 공개. 로그인은 비밀번호+OTP로 보호)
   - 나온 `https://<기기이름>.<tailnet>.ts.net` 주소를 `~/dropship/.env`의 `PUBLIC_BASE_URL`에 넣습니다(텔레그램 알림 링크에 쓰임).
4. **쿠팡**: `bash ~/dropship/bin/status.sh`에 나오는 공인 IP를 Wing > OPEN API 키 허용 IP에 등록
5. **키 입력**: `~/dropship/.env`에 API 키 입력 → `launchctl kickstart -k gui/$(id -u)/com.dropship.app`
6. 실운영 전환은 `docs/runbook.md` §3 순서를 따릅니다.

### Mac이 꺼졌을 때 알림 받기(권장, 무료)
FileVault가 켜져 있으면 자동 로그인이 안 되므로, 정전으로 재부팅되면 로그인할 때까지 앱이 멈춥니다. 앱이 멈추면 텔레그램 알림도 못 보내므로 외부 감시를 붙입니다.
1. https://healthchecks.io 에 무료 가입 → **Add Check**
   - Period: 10 minutes, Grace: 20 minutes
   - Integrations에서 이메일(기본) 또는 Telegram 연결
2. 체크의 Ping URL(`https://hc-ping.com/…`)을 `~/dropship/.env`의 `HEARTBEAT_URL=`에 넣고 앱 재시작
3. 앱은 10분마다(주문 수집이 정상일 때만) 신호를 보냅니다. Mac이 꺼지거나 주문 수집이 멈추면 healthchecks.io가 알려 줍니다.

### 명령 모음
| 하고 싶은 일 | 명령 |
|---|---|
| 상태 보기(버전·서비스·헬스·공인IP·최근 백업) | `bash ~/dropship/bin/status.sh` |
| 지금 바로 업데이트 | `bash ~/dropship/bin/update.sh` |
| 특정 버전으로 되돌리기 | `bash ~/dropship/bin/update.sh <커밋SHA>` |
| 앱 재시작 | `launchctl kickstart -k gui/$(id -u)/com.dropship.app` |
| 로그 | `tail -f ~/dropship/logs/app.log` (업데이트: `updater.log`, 백업: `backup.log`) |
| 지금 백업 / 복구 | `bash ~/dropship/bin/backup.sh` / `bash ~/dropship/bin/restore.sh ~/dropship/backups/data-….tgz` |
| 제거(데이터 보존) / 전부 삭제 | `bash ~/dropship/bin/uninstall.sh` / `… --purge` |

### 주의
- **`~/dropship/.env`의 `PII_KEY`는 비밀번호 관리자에 따로 보관하세요.** 이 Mac이 고장 나면 백업(iCloud)과 이 키로 다른 Mac에서 복구합니다: `install.sh` → `.env` 복사 → `restore.sh`.
- 집 인터넷 공인 IP는 보통 오래 유지되지만 공유기 재부팅이나 통신사 사정으로 바뀔 수 있습니다. 바뀌면 알림이 오고, Wing에 새 IP를 추가하면 됩니다(예전 IP도 남겨 두어도 됨, 최대 10개).
- Mac이 꺼져 있던 동안의 주문은 다시 켜질 때 지난 24시간 안이면 자동으로 수집됩니다. 다만 출고 지연을 막으려면 상시 켜 두어야 합니다.

### 검증 내역(2026-10-13, 이 Mac에서 격리된 위치·라벨로 실제 설치 후 제거)
- 설치 → 기동 ✅
- 프로세스 강제 종료 → 1초 안에 재시작 ✅
- 관리자 생성 ✅
- 구버전·신버전 업데이트 ✅
- 고장 난 버전 배포 → 헬스체크 실패 → 자동 롤백 ✅
- 백업 → 데이터 삭제 → 복구 ✅
- launchd 환경에서 GitHub 확인 후 자동 업데이트 ✅
- 제거 후 흔적 없음 ✅
- Tailscale 연결은 이 Mac에 설치돼 있지 않아 검증하지 못했습니다.

---

## B. 리눅스 서버(Oracle Cloud Always Free 등, 선택)
고정 IP 서버가 필요해지면 이 방식으로 옮깁니다(데이터는 PostgreSQL 사용).
1. 서버에서 `sudo bash deploy/setup-vps.sh` 실행(Ubuntu 전용. 레포가 비공개이므로 `scp`로 스크립트만 복사해 실행)
2. GitHub Secrets에 `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`(권장 `DEPLOY_KNOWN_HOSTS`)를 등록 → main에 push할 때마다 GitHub Actions가 테스트 → 이미지(GHCR) → SSH 배포 → 헬스체크 → 실패 시 롤백까지 자동으로 처리합니다.
3. 시크릿이 없으면 배포 단계는 자동으로 건너뜁니다(Mac 홈서버만 쓸 때의 기본 상태).

## CI (공통)
main에 push하거나 PR을 만들면 GitHub Actions(`.github/workflows/ci-cd.yml`)가 다음을 실행합니다:
- 타입체크
- 테스트 81개
- 웹 빌드
- Docker 이미지 빌드와 컨테이너 스모크 테스트

**Mac 홈서버의 자동 업데이트는 이 CI를 통과한 커밋만 받아 갑니다.**
