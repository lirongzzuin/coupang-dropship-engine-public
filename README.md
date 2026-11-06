# coupang-dropship-engine

쿠팡 위탁판매를 사람 없이 돌리기 위한 **무인 운영 시스템**입니다.
상품 선정 → 쿠팡 등록 → 주문 수집 → 공급처 발주 → 송장 업로드 → 정산 대사까지 한 프로세스가 처리하고, 사람은 예외 알림만 처리합니다.
개인 Mac 한 대를 홈서버로 두고 실제 운영 중인 시스템의 공개용 사본입니다(계정·운영 수치는 제거하거나 예시 값으로 바꿨습니다).

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js_24-339933?logo=node.js&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-000000?logo=fastify&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL%20%2F%20PGlite-4169E1?logo=postgresql&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black)
![Vitest](https://img.shields.io/badge/Vitest-6E9F18?logo=vitest&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?logo=githubactions&logoColor=white)

> 개발 방식: Claude Code 와 함께 설계·구현했습니다(커밋의 `Co-Authored-By` 참고). 리서치·타당성 검토·설계 문서(`docs/`)를 먼저 쓰고 그에 맞춰 구현했습니다.

---

## 무엇을 해결하나

위탁판매는 "도매 공급처 상품을 쿠팡에 올리고, 주문이 오면 공급처에 고객 주소로 대신 주문"하는 구조입니다. 손이 많이 가는 반복 작업이고, 실수 한 번이 곧 손실이나 판매자 점수 하락으로 이어집니다.

| 사람이 하던 일 | 이 시스템 |
|---|---|
| 팔 상품 찾기 | 네이버 검색광고·데이터랩·구글 트렌드·공급처 데이터로 키워드를 발굴하고, 수요·이익·경쟁가 기준으로 후보를 점수화 |
| 쿠팡 등록 | 카테고리 추천·고시정보·구매옵션(색상·사이즈)·이미지(.jpg 변환)를 자동 생성해 등록 |
| 주문 확인·발주 | 주문을 주기적으로 수집 → 재고·가격 재확인 → 공급처 API로 발주(API가 없으면 "구매 작업"으로 사람에게 넘김) |
| 송장 입력 | 공급처 송장 회수 → 택배사 코드 판별 → 쿠팡 업로드 |
| 가격·재고 관리 | 공급가·재고 변동을 반영하고, 판매 결과로 마크업을 조정. 하한가(최소 이익) 아래로는 절대 내리지 않음 |
| 취소·반품·교환·문의 | 클레임을 접수 단위로 끝까지 처리, 문의 수집·답변 |
| 정산 확인 | 쿠팡 매출내역과 주문별 손익 대사, 실수수료율 학습 |

판매채널은 쿠팡이 기본이고 네이버 스마트스토어를 두 번째 채널로 붙일 수 있습니다(기본 꺼짐). 공급처는 오너클랜(API 자동 발주)·도매꾹/도매매 어댑터가 있습니다.

---

## 아키텍처

단일 Node.js 프로세스 안에 API 서버·스케줄러·작업을 둔 **모듈러 모놀리스**이고, 외부 서비스는 포트-어댑터로 분리했습니다.

```
                ┌──────────── 관리자 웹 (React, 모바일 우선) ────────────┐
                │  로그인: 비밀번호 + TOTP / 접속: Tailscale(tailnet 전용) │
                └──────────────────────────┬──────────────────────────────┘
                                           │ /api
┌──────────────────────────── server (Fastify) ─────────────────────────────┐
│ jobs/scheduler   주기 작업 목록 1곳 · 실행 이력(job_runs) · 중복 실행 방지     │
│ modules/         selection · listing · pricing · orders · sync · finance   │
│                  cs · monitor · guard(안전장치) · reports · naver           │
│ ports/           MarketPort · SourceAdapter · Notifier …  ← 모듈은 여기만 의존 │
│ adapters/        coupang(HMAC) · naver · ownerclan · domeggook · telegram   │
│                  dryRunMarket(부작용 차단 래퍼) · fake(테스트·체험)          │
│ db/              Kysely + 번호 붙은 마이그레이션 013개 (PGlite | PostgreSQL)  │
└───────────────────────────────────────────────────────────────────────────┘
```

- **포트-어댑터**: 쿠팡·공급처 사양이 바뀌면 어댑터 파일만 고칩니다. 새 공급처는 `SourceAdapter` 구현 + 레지스트리 한 줄, 새 판매채널은 `MarketPort` 구현으로 붙습니다(스마트스토어가 이 방식으로 추가됨).
- **DB 이중 지원**: 홈서버는 내장 PGlite(Docker 불필요), 리눅스 서버는 PostgreSQL. 같은 마이그레이션을 씁니다.
- **사업 파라미터는 코드 밖에**: 수수료·마진·한도·주기는 `settings`(DB)에 두고 관리자 웹에서 바꿉니다. 바꾼 값만 저장해 기본값 개선이 자동 반영됩니다.

설계 근거는 `docs/` 에 있습니다: `research.md`(API·정책 조사, 출처·확인일) → `feasibility.md`(기능별 자동화 판정·리스크) → `architecture.md` → `selection-model.md` · `profit.md` · `runbook.md` · `deploy.md`.

---

## 기술적으로 집중한 문제

### 1. 실수로 실제 주문·결제가 나가지 않게 — 기능별 안전 플래그
- **문제**: 쿠팡 OPEN API 에는 샌드박스가 없습니다. 개발·점검 중 호출이 그대로 실제 등록·발주가 됩니다.
- **해결**: 모든 외부 부작용(등록·가격·송장·발주·CS 답변)은 `DryRunMarket` 래퍼를 통과합니다. `DRY_RUN=true`(기본)이면 모든 기능 플래그보다 우선해 차단하고, 실운영은 `LIVE_LISTING`·`LIVE_PRICING`·`LIVE_FULFILLMENT`·`LIVE_ORDERING`·`LIVE_CS` 를 하나씩 켭니다. 조회는 그대로 통과해 실제 데이터로 점검할 수 있습니다.
- **반대 방향 사고도 막음**: 실제 쿠팡 상품에 들어온 실제 주문이 스위치 조합 때문에 "모의 처리"로 사라지면 아무도 상품을 사지 않는 사고가 됩니다. 이 경우 사람 구매 작업으로 넘기고 알림을 보내며, 이를 `golive.test.ts` 로 고정했습니다.

### 2. 주문 처리의 정합성 — 선언적 상태머신 + 낙관적 잠금
- 주문 상태 전이는 `orders/stateMachine.ts` **표 하나**로 정의합니다(정상 경로 + 품절·역마진·한도 초과·공급처 오류·취소·반품·배송지 변경 등 예외 상태).
- 전이는 `UPDATE … WHERE status = 이전상태` 로 처리해 동시에 두 작업이 같은 주문을 처리하지 못하게 하고, 모든 전이를 `order_events` 에 남깁니다.
- 중복 수집은 `(market, shipmentBoxId, vendorItemId)` 유니크로, 중복 발주는 공급처 멱등키로 막습니다.
- 발주 전에 쿠팡 "상품준비중" 처리 후 배송지를 다시 조회합니다(결제 직후 고객이 주소를 바꾸는 경우).
- 품절·역마진이어도 **자동 취소하지 않습니다**(판매자 강제취소는 판매자 점수 하락). 대신 해당 상품을 즉시 판매중지하고 사람에게 넘깁니다.

### 3. 문제가 생기면 스스로 멈추기 — 자동 안전장치(watchdog)
- 주기 작업 `watchdog` 이 출고 기한 초과 주문, 주문 수집 장시간 실패, 같은 작업 연속 실패, 오래 처리되지 않은 주문, 미답변 문의를 감지합니다.
- 감지 → 텔레그램 경고 → 유예 시간 안에 해결되지 않으면 **쿠팡 판매 상품 전체 판매중지**(새 주문 차단). 짧은 시간에 예외 주문이 몰리면 구조적 오류로 보고 유예 없이 즉시 중지합니다.
- 이미 결제된 주문은 계속 처리합니다(멈추면 그 구매자가 피해를 봄). 재개는 관리 화면이나 `resume-sales.sh` 로만 하고, 남은 문제가 있으면 다시 자동 중지됩니다.
- 별개로 관리자 kill switch 가 있습니다.

### 4. 무인 배포·복구 — CI 통과분만 받아 가는 자동 업데이트와 롤백
- GitHub Actions: 타입체크 → 테스트 → 웹 빌드 → Docker 이미지 빌드 → **컨테이너 스모크 테스트(체험 모드로 기동 후 `/healthz`)** → GHCR 푸시. 서버 시크릿이 있으면 SSH 배포 + 헬스체크 + 실패 시 롤백.
- Mac 홈서버(`deploy/mac/`): launchd 가 5분마다 `update.sh` 실행 → **main 에서 CI 를 통과한 최신 커밋만** 체크아웃 → 빌드 → 재시작 → 90초 헬스체크 → 빌드나 기동이 실패하면 **이전 커밋으로 자동 롤백** 후 텔레그램 알림. 잠금 디렉터리로 중복 실행을 막습니다.
- 앱은 launchd 로 상시 실행(죽으면 재시작), 매일 데이터 백업(로컬 + iCloud Drive 사본, 보관 기간 지나면 정리), `restore.sh` 로 복구.
- 공인 IP 변경 감시(쿠팡 API 는 허용 IP 에서만 호출됨), 외부 heartbeat(healthchecks.io) 로 Mac 자체가 꺼진 경우도 감지합니다.
- `docs/deploy.md` 에 설치 → 강제 종료 후 재시작 → 고장 난 버전 배포 시 롤백 → 백업·복구를 격리된 위치에서 실제로 검증한 기록이 있습니다.

### 5. 감사·개인정보
- 관리자 행위(설정 변경, kill switch, 작업 수동 실행, 주문 상태 변경, **수취인 원문 열람**)를 `audit_log` 에 기록합니다.
- 수취인 이름·전화·주소는 AES-256-GCM 으로 컬럼 암호화(`PII_KEY`)하고, 화면·로그·알림에서는 마스킹합니다. 배송 완료 후 보관 기간이 지나면 PII 컬럼을 파기합니다.
- 관리자 로그인은 비밀번호 해시 + TOTP, HttpOnly·SameSite=Strict 세션 쿠키, 로그인 시도 제한. 관리 화면은 tailnet 에서만 열리고, 쿠팡이 내려받아야 하는 상품 이미지(`/media`)만 따로 공개합니다.

### 6. 알림 피로 줄이기
- 작업 실패 알림은 핵심 작업(주문·송장·재고·문의·감시)만 텔레그램으로 보내고, 나머지는 관리 화면에만 남깁니다. 같은 알림은 일정 시간 묶습니다.
- 야간(한국시간 23~07시)에는 급한 알림만 즉시 보내고 나머지는 아침에 한 통으로 모읍니다.
- 아침 브리핑은 처리할 일이 있을 때만 보냅니다.

### 7. 외부 API 의 실제 동작에 맞추기
공식 문서와 다르게 동작하는 부분은 실제 응답을 확인해 코드와 테스트에 고정했습니다. 예:
- 쿠팡 교환 조회는 구간 7일 미만만 허용 → 6일씩 나눠 조회. 매출내역은 1개월 미만만 허용.
- Wing 에서 삭제한 상품은 옵션 조회가 오류가 아니라 "판매중지"로 나옴 → 상품 조회로 삭제 여부를 확인해 정리.
- 쿠팡은 "상세페이지 참조" 같은 의미 없는 옵션값을 거부 → 공급처 옵션 이름에서 색상·사이즈를 해석해 채움.
- 11번가 검색어를 EUC-KR 로 보내면 항상 0건 → UTF-8 로 수정.
- 쿠팡 HMAC 서명, 429 재시도·감속, 공급처 호출 한도(1rps) 대응.

### 8. 상품 선정·가격 (사업 로직)
- 키워드: 검색광고 연관어를 공급처에 실제 상품이 있는지 확인한 뒤에만 풀에 넣고, 빠른 공급처부터 시간 한도 안에서 확인합니다.
- 선정: 게이트(출고일·판매자 만족도·KC·이미지 재사용 허락·시장가) → 기대 월판매·월이익 기반 수요 모델로 점수화. 실제 판매 결과로 계수를 보정합니다(`docs/selection-model.md`).
- 가격: 옵션별 하한가(최소 이익·이익률·최저판매준수가) 위에서 마크업을 조정합니다. 출시 기간 저가 → 판매 속도를 보며 인상, 이익이 줄면 최고 기록으로 복귀, 장기 무판매면 교체(`docs/profit.md`).

---

## 품질 / 테스트

```bash
pnpm test        # server: 테스트 파일 22개, 테스트 357개 (단위·통합·E2E·HTTP·어댑터)
pnpm typecheck   # server + web
```
- 외부 서비스는 `FakeMarket`·`MockSource` 와 주입 가능한 시계(`clock`)로 대체해, 주문 생성부터 정산·클레임·안전장치까지 시간 흐름을 포함한 E2E 를 돌립니다.
- 어댑터 테스트는 실제 API 응답 형태를 픽스처로 씁니다.
- CI 에서 같은 테스트와 Docker 스모크 테스트를 돌리고, 통과한 커밋만 운영 서버가 받아 갑니다.

---

## 실행 방법

### 체험 모드 (API 키 없이)
가짜 쿠팡·가짜 공급처만 쓰므로 실제 주문·결제가 일어나지 않습니다.
```bash
pnpm install
pnpm --filter web build
cd server
cp ../.env.example .env
# .env 에서 아래 값만 바꿉니다
#   PII_KEY=$(openssl rand -hex 32)   SESSION_SECRET=$(openssl rand -hex 16)
#   MARKET_ADAPTER=fake  DEMO_MODE=true  DRY_RUN=false  LIVE_*=true  PUBLIC_BASE_URL=http://localhost:8080
set -a; . ./.env; set +a
pnpm admin:create admin '비밀번호10자이상'   # 출력된 OTP 비밀키를 인증 앱에 등록
WEB_DIR=../web/dist pnpm dev
```
http://localhost:8080 에 로그인합니다. `POST /api/demo/order`(주문 생성), `POST /api/demo/advance`(배송 진행)로 흐름을 시험할 수 있습니다.

### 개발
```bash
pnpm dev         # 서버(tsx watch, PGlite 내장 DB)
pnpm dev:web     # 관리자 웹(Vite, /api 프록시)
```

### 운영 배포
- **Mac 홈서버**: `bash deploy/mac/install.sh` (launchd 서비스·자동 업데이트·백업 설치). 자동 업데이트가 받아 갈 저장소는 `DROPSHIP_REPO` 로 지정합니다.
- **리눅스 서버**: `deploy/setup-vps.sh` + `docker-compose.yml`(앱 + PostgreSQL + Caddy 자동 HTTPS) + GitHub Actions SSH 배포.
- 자세한 절차와 실운영 전환 순서는 `docs/deploy.md`, `docs/runbook.md`.

---

## 설정

모든 비밀값은 환경변수로만 받습니다. 목록과 설명은 `.env.example` 에 있습니다.

| 구분 | 변수 |
|---|---|
| 필수 | `PII_KEY`(개인정보 암호화 키), `SESSION_SECRET`, `PUBLIC_BASE_URL` |
| 안전 플래그 | `DRY_RUN`(기본 true), `LIVE_LISTING` · `LIVE_PRICING` · `LIVE_FULFILLMENT` · `LIVE_ORDERING` · `LIVE_CS` |
| 쿠팡 | `COUPANG_VENDOR_ID`, `COUPANG_ACCESS_KEY`, `COUPANG_SECRET_KEY` (선택: 쿠팡 파트너스 키) |
| 공급처 | `OWNERCLAN_USERNAME` / `OWNERCLAN_PASSWORD`, `DOMEGGOOK_API_KEY` |
| 시장 데이터 | 네이버 개발자센터·검색광고 키, `ELEVENST_API_KEY`(선택), `GOOGLE_TRENDS_ENABLED` |
| 스마트스토어(선택) | `NAVER_COMMERCE_CLIENT_ID`, `NAVER_COMMERCE_CLIENT_SECRET` |
| 알림·감시 | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `HEARTBEAT_URL`(선택) |

사업 파라미터(수수료·마진·마크업·한도·작업 주기·출고지/반품지 등)는 관리자 웹 **설정**에서 바꿉니다.
