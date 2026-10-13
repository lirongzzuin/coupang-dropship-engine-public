# coupang-dropship-engine

쿠팡 마켓플레이스 위탁판매 무인 운영 시스템.
도매몰·네이버 데이터로 상품을 고르고 쿠팡에 자동 등록합니다. 주문이 들어오면 공급처에 고객 배송지로 대신 발주하고, 송장 회수·업로드·정산 대사까지 처리해 그 차액을 수익으로 남깁니다.

- 운영 형태: **무료 — Mac 홈서버(상시 실행) + 모바일 웹 관리자 + 텔레그램 알림** (선택 이유: `docs/deploy.md`)
- 정상 주문(API 발주 가능 공급처)은 **무개입**으로 처리하고, 사람은 예외 알림만 처리합니다.
- 모든 외부 부작용은 기본 `DRY_RUN=true`(모의 실행)입니다.

## 문서
| 문서 | 내용 |
|---|---|
| `docs/research.md` | 쿠팡·공급처·네이버 API, 정책, 법규 조사(출처·확인일) |
| `docs/feasibility.md` | 기능별 자동화 판정, 손익분기 표, 리스크 |
| `docs/architecture.md` | 배포 결정, 모듈 구조, 상태머신, 변경 용이성 원칙 |
| `docs/selection-model.md` | 상품 선정 게이트·점수 수식 |
| `docs/runbook.md` | **매일/매주 할 일, 장애 대응, 실운영 전환 절차** |
| `docs/deploy.md` | **무료 운영 환경(Mac 홈서버) 설치·자동 업데이트·백업, 서버 대안** |

## 빠른 체험(키 없이, 내 PC)
```bash
pnpm install
pnpm --filter web build
cd server
cp ../.env.example .env   # 아래 값만 바꾸면 됨
# .env: PII_KEY=$(openssl rand -hex 32) SESSION_SECRET=$(openssl rand -hex 16)
#       MARKET_ADAPTER=fake DEMO_MODE=true DRY_RUN=false LIVE_*=true PUBLIC_BASE_URL=http://localhost:8080
set -a; . ./.env; set +a
pnpm admin:create admin 비밀번호10자이상   # 출력된 OTP 비밀키를 인증 앱에 등록
WEB_DIR=../web/dist pnpm dev
```
http://localhost:8080 에 로그인하면 됩니다. 체험 모드에서는 가짜 쿠팡·가짜 공급처만 쓰므로 실제 주문·결제가 일어나지 않습니다.
`POST /api/demo/order`(주문 생성)와 `POST /api/demo/advance`(배송 진행)로 흐름을 시험할 수 있습니다.

## 운영 환경 — 무료(Mac 홈서버)
```bash
bash deploy/mac/install.sh      # 이 Mac에 1회 설치
```
- 앱 상시 실행(죽으면 재시작), **5분마다 CI를 통과한 새 버전 자동 업데이트(실패하면 롤백)**, 매일 백업(iCloud 사본), 공인 IP 변경 감시가 자동으로 돌아갑니다.
- 휴대폰 접속은 Tailscale(무료 HTTPS)을 씁니다. 자세한 내용과 고정 IP 서버(Oracle 무료 등) 대안은 **`docs/deploy.md`**에 있습니다.
- 개발 흐름: 코드 수정 → `git push` → GitHub CI 통과 → 5분 안에 Mac에 자동 반영.

## 개발
```bash
pnpm test        # 서버 테스트 81개(단위·통합·E2E·HTTP·어댑터)
pnpm typecheck
pnpm dev         # 서버(tsx watch) — PGlite 내장 DB 사용, Docker 불필요
pnpm dev:web     # 관리자 웹(Vite, /api 프록시)
```

## 구조
```
server/src
  config/    env(비밀·플래그), settings(수수료·마진·한도 — 웹에서 수정, 출처 주석)
  ports/     MarketPort(판매채널) · SourceAdapter(공급처) · Notifier …   ← 모듈은 여기에만 의존
  adapters/  coupang · ownerclan · domeggook · naver · telegram · fake(테스트/체험)
  modules/   pricing · selection · listing · orders · sync · finance · cs · reports
  jobs/      스케줄러(주기 작업 목록 1곳)
  http/      관리자 API(로그인+OTP, CSRF 방어)
web/src      관리자 화면(모바일 우선)
```
새 공급처는 `SourceAdapter`를 구현하고 `app.ts`에 한 줄 등록하면 붙습니다. 새 판매채널은 `MarketPort`를 구현하면 됩니다.
