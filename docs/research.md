# Phase 0 — 리서치 (research.md)

- 작성일 / 모든 출처 확인일: **2026-10-13** (별도 표기가 없으면 이 날짜에 웹에서 직접 확인)
- 신뢰도 표기
  - **[공식]** 해당 기관·회사의 공식 문서·공지·배포 자료에서 직접 확인
  - **[2차]** 블로그·언론·셀러 커뮤니티 등 2차 자료. 공식 원문과 대조 필요
  - **[미확인]** 공개 자료로 확인하지 못함. 설계 시 교체 가능한 config/어댑터로 처리
- 쿠팡 개발자 포털이 2026-07에 리뉴얼되어 `developers.coupang.com`으로 이전되었고, 구 포털(v1)은 2026-10-06 운영 종료 공지가 있다. [공식] https://developers.coupang.com/hc/ko → https://developers.coupang.com/ko/notices/54f5ef70-1092-47ee-8b4d-aca14f228df7

---

## 2-1. 쿠팡 OPEN API

### 인증·키·IP·호출 한도

| 항목 | 내용 | 신뢰도 / 출처 |
|---|---|---|
| 인증 방식 | HMAC-SHA256. 서명 메시지는 `signed-date(yyMMdd'T'HHmmss'Z', UTC) + HTTP method + path + querystring(물음표 제외)`를 연결한 문자열이고, 결과는 hex(소문자)로 인코딩한다. 헤더는 `Authorization: CEA algorithm=HmacSHA256, access-key=…, signed-date=…, signature=…` | [공식] https://developers.coupang.com/ko/getting-started/creating-hmac-signature |
| 허용 시계 오차 | 문서에 명시 없음. "Specified signature is expired" 401 FAQ는 있음 → NTP 동기화 필수 | [미확인] |
| 키 유효기간 | **180일**. 만료 2주 전·1주 전에 대표 이메일로 안내. 재발급 버튼은 **만료 14일 전부터 활성화**되며, 재발급하면 Secret Key가 새로 생성됨 | [공식] https://developers.coupang.com/ko/getting-started/issue-open-api-keynew |
| 재발급 후 반영 | 재발급·정보 수정은 **최대 30분 이내** 반영. 최초 발급은 24시간 이상 걸릴 수 있음 | [공식] 위와 같음 |
| IP 화이트리스트 | 키당 **최대 10개** | [공식] 위와 같음 |
| 발급 선행 조건 | 공식 문서: Wing 판매자 등록 + 사업자 인증, 판매정지 상태가 아닐 것. **실제 Wing 화면에서는 상품 1개 이상 등록을 요구함**(사용자 확인 2026-10-13, 문서 미기재) → 첫 상품은 Wing에서 수동 등록 후 관리자 웹 '쿠팡에 직접 등록한 상품 연결'로 자동 관리에 편입 | [공식] 위와 같음 / 사용자 확인 |
| 연동정보 수정 | **주 10회** 제한 | [공식] 위와 같음 |
| 테스트 환경 | **별도 테스트(샌드박스) 환경 없음** → DRY_RUN·mock 필수 | [공식] 위와 같음 |
| Rate limit | 업체코드(vendorId)별 **초당** 호출 수 제한. 초과하면 즉시 차단되고 **HTTP 429**를 반환하며, 수 분~수십 분 뒤 해제됨. 과도한 호출이 지속되면 **영구 차단**될 수 있음. 상품 생성·수정·조회, 수량·가격·판매상태 변경 API가 대상이고, 한도는 예고 없이 변경 가능. **정확한 수치는 공식 공지에 없음** | [공식] https://developers.coupang.com/hc/ko/articles/23902034110617 (2023-10-12 정책 강화 공지) |
| Rate limit 수치 | 검색 요약에 "초당 5회 초과 vendorId에 제한"이라는 문구가 있었으나 원문에서 재확인하지 못함 | [미확인] https://developers.coupangcorp.com/hc/en-us/articles/20414599556889 |
| 429 상세 | 임계치(약 90%)에 근접하면 429가 날 수 있음. 쓰로틀링 값은 `X-CAG-Warnings` 헤더로 전달됨 | [공식] https://developers.coupang.com/en/faq/what-should-i-do-when-a-429-error-is-returned |

→ **설계 반영**: 전역 토큰버킷(기본 2 rps, config)을 두고, `X-CAG-Warnings` 헤더를 파싱해 감속한다. 429를 받으면 지수 백오프와 서킷브레이커로 처리한다. 키 만료 D-14 알림을 둔다.

### API 범위 (공식 API 문서 목록, 총 99개 엔드포인트)
출처: [공식] https://developers.coupang.com/ko/api

| 영역 | 주요 엔드포인트 | 비고 |
|---|---|---|
| 카테고리 | 카테고리 추천 `POST /v2/providers/openapi/apis/api/v1/categorization/predict`, 카테고리 메타정보(고시정보·구매옵션 필수 항목) `GET …/meta/category-related-metas/display-category-codes/{code}`, 목록·유효성 검사 | 고시정보는 메타 API의 `noticeCategoryName`/`noticeCategoryDetailName`와 정확히 일치해야 함(불일치하면 400) |
| 상품 | 생성 `POST …/seller-products`, 등록 현황, 조회, 수정(승인필요/불필요), 승인 요청, 상태변경이력, 삭제 | `requested=true`로 저장하면 자동 승인 요청 |
| 아이템(옵션) | 가격 변경 `PUT …/vendor-items/{id}/prices/{price}`, 수량 변경, 판매 중지·재개, 수량/가격/상태 조회, 할인율 기준가 변경 | 가격 변경 폭: **기존가 대비 최대 50% 인하 / 100% 인상**. 초과하면 `forceSalePriceUpdate=true` 필요 [공식 FAQ](https://developers.coupang.com/ko/faq/i-get-the-following-error-could-not-change-the-sales-price-you-can-change-within) |
| 발주서(주문) | **분단위 전체 조회** `GET /v2/providers/openapi/apis/api/v5/vendors/{vendorId}/ordersheets?searchType=timeFrame` (조회 구간 **24시간 이내**), 일단위 페이징 조회, 단건 조회(orderId/shipmentBoxId), 배송상태 변경 히스토리 | 상태값: ACCEPT(결제완료), INSTRUCT(상품준비중), DEPARTURE, DELIVERING, FINAL_DELIVERY, NONE_TRACKING. **결제 후 고객이 배송지를 바꿀 수 있으므로 상품준비중 처리 후 단건 재조회 권장** [공식](https://developers.coupang.com/ko/api/shipments/po-list-query-by-minute) |
| 상품준비중 | `PATCH …/v4/vendors/{vendorId}/ordersheets/acknowledgement` | 송장 업로드는 **상품준비중 상태에서만** 가능 |
| 송장 | 업로드 `POST …/v4/vendors/{vendorId}/orders/invoices`, 업데이트 | 결과 항목별 `retryRequired` 플래그 제공. 송장번호 형식은 택배사별로 검증. 6개월 내 송장번호 중복은 에러. **허위·지연 송장으로 고객이 취소하면 배송비는 판매자 부담** [공식](https://developers.coupang.com/ko/api/shipments/uploading-waybills) |
| 주문 취소(판매자) | `POST …/v5/vendors/{vendorId}/orders/{orderId}/cancel` | 결제완료면 즉시 취소, 상품준비중이면 출고중지. 사유가 "파트너 API 강제 취소"로 기록되고 **판매자 점수(주문이행)가 하락함**을 문서에 명시 [공식](https://developers.coupang.com/ko/api/shipments/cancel-an-order) |
| 반품/취소 요청 | 목록·단건 조회, 승인, 입고 확인, 회수 송장 등록, 반품철회 이력, 이미출고/출고중지완료 처리 | 2026-10-06부터 반품불가 카테고리의 '고객 취소 요청 거절' 사양 변경 [공식](https://developers.coupang.com/ko/notices/Notice-of-Customer-Cancellation-Request-Rejection-Feature) |
| 교환 | 목록, 입고 확인, 거부, 교환상품 송장 업로드 | |
| CS | 상품별 고객문의 조회·답변, 쿠팡 고객센터 이관문의 조회·답변·확인 | |
| 정산 | 매출내역 조회 `GET /v2/providers/openapi/apis/api/v1/revenue-history` (매출인식일 기준, **최대 31일 구간, 전일까지**), 지급내역 조회 | 매출인식일은 "배송완료+7일" 또는 "구매확정". 응답에 `serviceFee`, `serviceFeeVat`, `serviceFeeRatio`(VAT 별도 %), `settlementAmount`, `deliveryFee.{fee,feeVat,feeRatio}` 포함. **대사 키는 `vendorItemId` 권장**(productId는 병합·분리 시 바뀜) [공식](https://developers.coupang.com/ko/api/settlement/sales-detail-query) |
| 물류 | 출고지·반품지 생성/조회/수정, 택배사 코드 | |
| 프로모션 | 즉시할인쿠폰, 다운로드쿠폰 | |

### 질의 항목별 결론

| 질문 | 결론 | 근거 |
|---|---|---|
| 내 상품의 판매·조회 지표를 API로? | **판매**: 발주서·매출내역 API로 자사 판매량은 집계 가능. **조회수·전환율 API는 API 목록에 없음** → 판매 0 기반 판정만 자동화하고, 조회수는 Wing에서 수동 CSV로 받는 보조 입력 | [공식] API 목록 전수(99개)에 통계·트래픽 API 없음 |
| 아이템위너/경쟁 최저가를 API로? | **불가.** "상품구성, 카탈로그 매칭관리, 자동가격조정 기능은 OpenAPI에서 지원하지 않습니다. WING에서 이용" | [공식] https://developers.coupang.com/ko/faq/are-product-composition-catalog-matching-management-functions-supported-by-opena / 수량·가격·상태 조회 응답에는 `sellerItemId, amountInStock, salePrice, onSale`만 있음 [공식](https://developers.coupang.com/ko/api/products/query-quantitypricestatus-by-product-items) |
| 이미지 등록 방식 | `vendorPath`(외부 URL, 포트 80/443, 200자 이내. 쿠팡이 다운로드해 CDN에 적재) 또는 `cdnPath` 중 하나 이상. 대표이미지(REPRESENTATION) 필수, 추가이미지(DETAIL) 최대 9장. **JPG/PNG, 3MB 이하, 정사각형, 500~5000px**. 다운로드 실패하면 승인 반려(FAQ #38) | [공식] https://developers.coupang.com/ko/api/products/product-creation |
| → 이미지 호스팅 필요? | **필요.** 쿠팡에 직접 업로드하는 API가 목록에 없고 외부 URL 다운로드 방식이므로, 가공한 이미지(리사이즈·상세페이지 렌더링)는 R2/S3 공개 URL로 호스팅해야 함 | 위와 같음 |
| 상품 등록 기타 제약 | 상품명 100자, 옵션명 150자, 검색태그 20개×20자, 옵션 최대 200개. 등록 후 카테고리 변경 불가 | [공식] 위 문서, [공식] https://cloud.mkt.coupang.com/Fee-Table |
| GTIN/모델번호 | 공식 식별자가 있는 브랜드 상품은 입력 의무(API 등록은 **2026-08-01부터**). 노브랜드·자체제작은 예외이며 **임의 번호 입력 금지**. 누락하거나 부정확하면 등록·노출 제한 | [공식] https://developers.coupang.com/ko/notices/clarification-on-product-identifier-gtinmodel-number-requirement-and-scopepublis |
| 승인 소요 시간 | 문서에 없음 | [미확인] → 상태 폴링으로 추적 |

---

## 2-2. 쿠팡 정책

### 판매수수료

| 항목 | 내용 | 신뢰도 / 출처 |
|---|---|---|
| 카테고리별 수수료 | 공식 공개 수수료표는 **"2019년 11월 25일 기준"**. 기본 수수료는 가전디지털 7.8%, 생활용품 7.8%, 뷰티 9.6%, 출산/유아 10%, 자동차용품 10%, 패션 10.5%, 식품 10.6%, 가구/홈·주방·문구·스포츠·완구·반려·도서 10.8%. 세부 카테고리 예외는 4%~10.9% | [공식] https://cloud.mkt.coupang.com/Fee-Table |
| 최신성 | 2024~2026 셀러 블로그의 표가 위 수치와 동일 → 큰 변동은 없어 보이나, **현행 수치는 Wing 로그인 화면에서 확인 필요** | [2차] https://www.windly.cc/blog/coupang-fees , https://silmupack.com/쿠팡-수수료-총정리/ |
| 수수료 부과 기준 | "할인된 가격에 수수료를 부과". "결제수수료를 이중으로 부과하지 않습니다"(별도 PG 수수료 없음) | [공식] Fee-Table |
| 수수료 VAT | 정산 API에 `serviceFee`와 `serviceFeeVat`가 분리되어 있고, `serviceFeeRatio`는 "VAT 별도" → **실제 차감 = 수수료율 × 1.1** | [공식] 매출내역 조회 API |
| 배송비 수수료 | 고객이 낸 배송비에 **3.3%** (3%라는 자료도 있음). 정산 API에 `deliveryFee.fee/feeVat/feeRatio`가 있어 존재 자체는 공식 확인 | 요율은 [2차] windly, 존재는 [공식] |
| 월 서비스 이용료 | 월 매출 100만원 이상이면 **55,000원**(가전디지털은 500만원 이상) | [2차] windly / [미확인] 공식 |
| 정산 주기 | 구매확정 또는 배송완료+7일에 매출 인식(공식). 지급 주기(주정산/월정산 비율)는 공식 원문을 확인하지 못함 | 인식 기준 [공식], 지급 주기 [미확인] |

### 배송·계정 건전성

| 항목 | 내용 | 신뢰도 / 출처 |
|---|---|---|
| 출고소요일 | 판매자가 설정. 주말·공휴일·휴무일은 제외. 실제보다 짧게 잡으면 지연과 판매자점수 하락으로 이어짐 | [공식] https://marketplace.coupang.com/information-center/shipement-overview-ur3yd |
| 배송 우수 기준 | 직전 2주 기준 출고소요일 1일 이하, **정시출고 99% 이상, 정시배송 95% 이상** (우수 배지 기준) | [공식] 위와 같음 |
| 판매자 점수 | 주문·배송·서비스 영역을 측정. 국내배송의 정시배송완료는 참고지표(패널티 없음). **주의/경고/정지 단계**가 있으며, 수치 기준은 로그인 후 이미지로만 제공됨 | [공식] https://marketplace.coupang.com/information-center/blog-news10 / 임계값 [미확인] |
| 판매자 점수 항목(과거) | 주문이행, 정시배송완료, 24시간 내 답변. 주문이행 점수는 고객 변심 취소도 차감한다는 보도 | [2차] https://www.bizhankook.com/bk/article/19640 |
| 판매자 강제 취소 | 판매자 점수(주문이행) 하락을 API 문서에 명시 | [공식] 주문 상품 취소 API |
| 아이템위너 | 동일상품을 묶어 1위 판매자를 대표로 노출. 가격·배송·판매자점수 등이 반영된다는 2차 설명 | [2차] https://www.windly.cc/blog/coupang-item-winner-exposure-restriction / 산정식 [미확인] |
| 가격 변경 | API 1회 변경 폭 −50%/+100% 제한. 하루 변경 횟수 제한은 공식 자료 없음 | [공식] FAQ / 횟수 [미확인] → config로 자체 제한 |

### 상품명·썸네일·판매불가

| 항목 | 내용 | 신뢰도 / 출처 |
|---|---|---|
| 상품명 금지 문구 | 2026-06 정책 변경 관련: "무료배송·할인·세일·최저가·특별가·한정수량·신상·인기상품·1+1·당일출고·국내발송" 같은 프로모션·배송 문구, 판매자명·상점명, 기념일 문구 금지. 옵션(사이즈·색상)을 상품명에 중복 기재 금지 | [2차] https://www.i-boss.co.kr/ab-6141-71780 , sellernow.co.kr / 공식 원문 [미확인] |
| 대표이미지 | 이미지 위 텍스트 제한이 있다는 2차 언급. 흰 배경 등 구체 기준은 확인 못 함 | [미확인] → 금지문구 사전은 config로 두고 운영 중 갱신 |
| 판매 불가·인증 필요 품목 | 의약외품·의료기기(판매업 신고), 식품(영업허가·수입신고), 건강기능식품, **KC 등 법정의무인증 품목**(전기·생활용품, 어린이제품, 방송통신기자재 등), 생활화학제품·살생물제, 19금 품목 등 | [공식] https://marketplace.coupang.com/information-center/blog-news7 |
| 금지행위(약관 제14조) | 중복 등록, 카테고리 위반, 부정확한 상품정보, 권리침해, 반복적 배송 지연, 허위 배송정보 입력, **구매자 개인정보 침해**, 업무 방해 등. 제재는 패널티, 서비스 제한, 자격 정지, 계약 해지, 판매 중단 | [2차] https://www.lawtalk.co.kr/posts/163958 (약관 원문 https://www.coupang.com/np/policies/seller 는 서버 측 접근이 차단되어 원문 대조 못 함) |
| 등록 수 제한 | 판매자당 등록 수를 제한할 수 있음. 1년간 미판매 상품은 등록 취소 등 조치 가능 | [2차] 판매이용약관 인용 |
| 위조품 | 무관용 정책. 판매중지, 계정정지, 정산 보류 | [공식] https://marketplace.coupang.com/information-center/zero-tolerance-policy |
| 위탁판매 자체 | 공식 자료에서 국내 위탁판매를 금지하거나 별도 제한하는 조항은 **찾지 못함**. 구매대행은 판매불가 안내에 별도 제한이 있음 | [미확인] |
| 쿠팡 구매품 재판매 금지 | 요구사항 0절의 전제. 쿠팡 이용약관 원문을 서버에서 가져오지 못해(Akamai 403) **조문 확인 못 함**. 금지 전제를 유지하며 시스템적으로 구현하지 않음 | [미확인] — 직접 확인 필요: https://www.coupang.com/np/policies/terms |

---

## 2-3. 공급처 비교

조사 대상: 오너클랜, 도매꾹/도매매, 온채널, 젠트레이드, 스페셜오퍼. 비교는 **셀러가 자체 시스템에서 직접 호출할 수 있는 API**가 있는지를 기준으로 했다.

| 항목 | **오너클랜** | **도매꾹 / 도매매** | **온채널** | **젠트레이드** | **스페셜오퍼** |
|---|---|---|---|---|---|
| API 형태 | **GraphQL** (`https://api.ownerclan.com/v1/graphql`, 샌드박스 `api-sandbox.ownerclan.com`), JWT 인증(`auth.ownerclan.com/auth`에 ID/PW POST) | REST 형식(`mode=` 파라미터). Open API(공개)와 **Private API(권한 승인 필요)**. 세션(`sId`)은 로그인 API로 발급 | **셀러용 개발 API 미확인.** 온채널 UI에 마켓 API 키를 등록하는 연동 서비스 | 상품 XML API와 주문조회 API(문서는 로그인 후 열람) | REST(`/api/goods`, `/api/orders`). 인증키 발급 |
| 상품·가격·재고 API | `item`, `allItems`, `itemsByKeys`(1회 최대 5,000 key), **`itemHistories`(품절·단종·재입고·가격 등 41개 유형 변경 이력, 전체 조회는 7일 간격 제한)** | 상품조회 Open API, `전체품절확인목록` | UI 전송 | XML 상품 데이터 | 상품목록·상세 조회 |
| 위탁 발주 API | **`createOrder`** + 사전 금액 검증용 **`simulateCreateOrder`**(결과를 넘기면 금액이 달라질 때 주문 실패) | **`setOrder`(주문서 생성 v4.3)**: "사전 충전한 e-money를 사용하여 주문서를 생성" | 매일 08~09시 1회 자동 발주(UI 기능) | 주문 **조회만** 확인 | `POST /api/orders` 주문 생성 |
| 결제 방식 | 주문의 `transactions`는 "현재 **적립금 사용**만 지원"(kind=reserveTransfer) → **적립금 선충전 차감 구조로 판단**. 단, 매뉴얼 v0.11.0(2020-10)에 잔액 조회 메서드가 없음 | **e-money 선충전 차감** 명시. **회원자산(포인트·e-money 잔액) 조회 API 있음** | 온채널 포인트 자동 결제(부족하면 다음 회차에 재시도) | [미확인] | 응답에 `pay_method`, `use_point` 필드만 있음. 결제 API [미확인] |
| 송장 회신 | 폴링: `allOrders(shippedAfter, shippedBefore)`, 주문의 `trackingNumber`, `shippingCompanyName`, `shippedDate` | 폴링: 구매 주문서 상세 `items.delivery.code/company` | 공급사가 등록하면 마켓에 자동 반영 | [미확인] | 공급사가 PATCH로 등록. 셀러 측 조회는 주문조회로 |
| 웹훅 | 없음(문서상) | 없음(문서상) | — | — | 없음 |
| 취소 | `cancelOrder`(paid 상태만), `requestOrderCancellation` | `구매취소 신청` | UI | — | [미확인] |
| 반품·교환 | `requestRefundOrExchange`(v0.11.0 추가). 반품접수 유형 vendor/seller | `반품/교환 신청` | UI | — | — |
| 가격 정책 | `PricePolicy`: free(자율) / **fixed(소비자준수가격 → `fixedPrice` 확인 필수)**. 긴급메시지 `pricePolicyCompliance`(가격준수요청), `saleStop`(판매중지요청), **penalty 점수** | [미확인] | — | — | — |
| 출고 리드타임 | 상품별 `guaranteedShippingPeriod`(안전배송일) | 상품별 출고 정보(상세 [미확인]) | — | — | 상품별 `order_end_at`(발주마감 09:00~17:30) |
| 반품 가능 여부 | 상품별 `returnable`, `noReturnReason` | [미확인] | — | — | — |
| 고시정보 | 상품고시정보 가이드 별도 제공 → 쿠팡 고시정보 매핑에 활용 | [미확인] | — | — | — |
| 상세이미지 재사용 | 약관 원문 [미확인]. 위탁 구조상 이미지 제공이 관행이나 **허락 범위는 확인 필요** | [미확인]. 도매꾹발 지재권·이미지 분쟁 사례가 다수 보도됨 | — | — | — |
| API 이용 조건 | 로그인 후 API 센터 이용. 파트너용(대행) 키는 별도 발급. 호출 한도 [미확인] | **Private API는 권한 승인 후 사용**. 호출 한도 [미확인] | — | 직접 개발 필요 명시 | 호출 한도 [미확인] |
| 가격 변동 공지 | `itemHistories`(가격·품절 이력 API) + 긴급메시지 API | `전체품절확인목록` | — | — | — |
| 출처 | [공식] https://ownerclan.com/V2/service/api-center-guest-view.php , 매뉴얼 zip https://cdn.ownerclan.com/API%20%EB%A7%A4%EB%89%B4%EC%96%BC.zip (Seller Manual v0.11.0, 2020-10-21) | [공식] https://openapi.domeggook.com/ko/categories/API-%EB%AC%B8%EC%84%9C-e04594a5 , 주문서 생성 https://openapi.domeggook.com/ko/articles/%EC%A3%BC%EB%AC%B8%EC%84%9C-%EC%83%9D%EC%84%B1-68288eeb , 회원자산 https://openapi.domeggook.com/ko/articles/%ED%9A%8C%EC%9B%90%EC%9E%90%EC%82%B0%EB%82%B4%EC%97%AD%EC%A1%B0%ED%9A%8C-59d97afe | [공식] https://onchannelnotice.oopy.io/guide/api | [공식] https://www.zentrade.co.kr/shop/proc/open_api.php (로그인 필요) | [공식] https://specialoffer.kr/shop/open_api.php |

### 무인 결제 가능성 결론
- **도매꾹/도매매**: e-money 선충전 차감 주문 API와 잔액 조회 API가 모두 **공식 문서에 존재**한다. Private API 권한 승인이 전제다. → 무인 결제 **조건부 가능**.
- **오너클랜**: createOrder와 적립금 거래내역 구조로 보아 적립금 차감으로 판단된다. 다만 공개 매뉴얼이 2020년판이고 잔액 조회가 없다. **샌드박스로 실제 결제 흐름 검증이 필요**하다. → **조건부 가능(검증 필요)**.
- 두 곳 모두 검증에 실패하거나 승인이 나지 않으면 **"승인 1탭 후 결제"** 플로우로 대체한다. 텔레그램 승인 → 시스템이 발주 API 호출, 또는 사람이 웹에서 결제한 뒤 주문번호를 입력. 브라우저 자동화 결제는 금지 항목 2)라서 대안이 될 수 없다.
- **1순위 후보: 도매꾹/도매매** (결제·잔액 API가 문서상 명확). **2순위: 오너클랜** (가격준수정책·이력 API가 우수하고 샌드박스가 있음). 최종 선택은 두 곳의 API 승인 결과로 정한다.

---

## 2-4. 수요·시장 데이터 (2026-10-13 개정: 데이터랩 미제공 반영)

| 소스 | 사양 | 한도 | 시스템에서의 역할 | 신뢰도 / 출처 |
|---|---|---|---|---|
| **네이버 검색광고 키워드도구** | `GET https://api.searchad.naver.com/keywordstool` (HMAC). 입력 키워드와 **연관 키워드 목록**, 월간 PC/모바일 조회수(절대값, 적으면 "< 10"), 경쟁도 `compIdx`(낮음/중간/높음). **2025-09 광고계정 통합 → API 키는 '네이버 광고주센터'(ads.naver.com)에서 발급·확인**(릴리스노트 2025-08-12·2026-07-02, API는 2026-09에도 공지 갱신 중) | 다른 API 대비 1/5~1/6, IP 단위 제한. 429면 **5분 이상 전체 중단**(공식 가이드 2020-12-18) → 2초 간격 + 5분 차단기 | **핵심 수요 지표.** ① 월간 검색량 ② 시드별 연관 키워드 자동 확장(검색량 범위·경쟁도 필터) ③ **매일 저장한 검색량으로 월별 추이를 계산해 데이터랩 대체** | [공식] 릴리스노트 https://naver.github.io/searchad-apidoc/feed.xml (확인 2026-10-13), 에러코드 https://github.com/naver/searchad-apidoc / 필드명 [2차] |
| 네이버 쇼핑 검색 | `GET /v1/search/shop.json` display≤100 | 25,000회/일 | 시장 최저가·상품 수·판매처 수 | [공식] https://developers.naver.com/docs/serviceapi/search/shopping/shopping.md |
| 네이버 데이터랩(검색어트렌드·쇼핑인사이트) | `POST /v1/datalab/search` 등 | 1,000회/일 | **사용자 앱에서 제공되지 않음(사용자 확인 2026-10-13)** → 기본 off(`NAVER_DATALAB_ENABLED`), 권한이 있으면 켜서 사용 | [공식] 문서 / 사용자 확인 |
| **구글 트렌드** | 공식 API는 신청자 대상 알파(5년치, 일·주·월). 시스템은 trends.google.com 공개 웹 데이터(explore → widgetdata/multiline) 사용, 12개월 주간 값 | 비공식 → 8초 간격, 키워드당 하루 1회 캐시, 429면 1시간 휴식 | **보조 추세**(가중치 0.05). **실측: 한국 쇼핑 키워드 일부는 희소(0이 대부분)** → 0이 아닌 값이 30% 미만이면 무시. 이 Mac(가정용 IP)에서 정상 응답 확인 | [공식] https://developers.google.com/search/apis/trends (알파) / 실측 2026-10-13 |
| **쿠팡 파트너스 Open API**(선택) | `GET https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/products/search?keyword=&limit=10`, CEA HMAC. 상위 상품명·가격·로켓 여부·순위 | 검색 **시간당 10회**(2차 자료, 일부 분당 50회) → 시간당 10회 + 키워드당 7일 캐시 | **쿠팡 내 최저가로 가격 경쟁 게이트**(네이버보다 우선), 로켓배송 비율(높을수록 불리) | [2차] https://codedosa.com/12603 / 이용 조건(API 활성화 실적 요건, 약관상 제휴 목적 외 이용 제한 여부) **[미확인] — 직접 확인 필요** |
| 쿠팡 판매량·리뷰(유료 분석 툴 CSV) | 아이템스카우트·판다랭크·셀러라이프 등 내보내기 | — | 판매량 추정·리뷰 수·상품 수·평균가 열을 자동 인식해 저장(추정치, 기본 가중치 0) | [2차] / 포맷은 열 이름 후보로 인식 |
| **자사 판매 실적** | 주문 데이터 | — | 최근 14일 3건 이상 팔린 키워드는 자동으로 시드에 추가 | 내부 |

## 2-5. 법규·운영 체크리스트 (판단 아님: "확인 필요 + 근거")

| # | 항목 | 확인 필요 사항 | 근거 링크 |
|---|---|---|---|
| L1 | 사업자등록 | 일반과세자 여부(매입세액 공제 → 손익 모델이 일반과세자 기준) | 국세청 홈택스 https://www.hometax.go.kr |
| L2 | 통신판매업 신고 | 시·군·구 신고. 쿠팡 입점에 필요 | 전자상거래법 제12조 https://www.law.go.kr/법령/전자상거래등에서의소비자보호에관한법률 , 정부24 https://www.gov.kr |
| L3 | 식품 판매 | 가공식품 위탁판매도 품목·방식에 따라 **식품 영업신고(식품소분·판매업 등)** 대상이 될 수 있음. 건강기능식품은 **건강기능식품판매업 신고** 별도 | 식품위생법·시행령 https://www.law.go.kr/법령/식품위생법 , 관할 지자체 식품위생과 / [2차] https://www.tosspayments.com/blog/articles/semo-132 |
| L4 | 의료기기·의약외품 | 의료기기판매업 신고. 쿠팡 판매불가·인증필요 목록 | [공식] https://marketplace.coupang.com/information-center/blog-news7 |
| L5 | KC 인증 | 전기·생활용품, 어린이제품, 방송통신기자재는 **판매자에게도 인증정보 게시 의무** → 공급처 데이터에서 인증번호를 확보해야 함 | 전기용품 및 생활용품 안전관리법 https://www.law.go.kr/법령/전기용품및생활용품안전관리법 , 제품안전정보센터 https://www.safetykorea.kr |
| L6 | 청약철회·반품 책임 | 청약철회는 수령 후 **7일**(제17조). 단순변심 반환비용은 소비자 부담, 표시·광고와 다르면 사업자 부담(제18조). 환급은 **3영업일 이내**. **쿠팡 마켓플레이스에서 통신판매업자는 판매자** → 공급처 반품 정책이 이보다 불리하면 차액은 판매자 부담 | 전자상거래법 제17·18조 https://www.law.go.kr/법령/전자상거래등에서의소비자보호에관한법률 , 공정위 결정 https://www.law.go.kr/LSW/ftcInfoP.do?ftcSeq=489 |
| L7 | 개인정보 처리위탁 | 공급처에 수취인 정보를 넘기는 것은 **처리위탁(제26조)** 또는 **제3자 제공(제17조)** 중 무엇인지 확인 필요. 위탁이면 위탁계약 문서화와 위탁 사실 공개(처리방침 등) 의무. 쿠팡 판매자 약관의 구매자 정보 이용 제한 조항도 확인 | 개인정보보호법 https://www.law.go.kr/법령/개인정보보호법 , 개인정보보호위원회 https://www.pipc.go.kr / [2차] https://thecheck.co.kr/customer-data-outsourcing-contract-disclosure/ |
| L8 | 개인정보 파기 | 보유기간 경과 후 파기(제21조). 전자상거래법상 거래기록 보존 의무(계약·대금결제 5년, 소비자 불만 3년 등)와 충돌하므로 **"주문 기록 보존 + 수취인 PII 분리 파기"** 정책 확인 | 전자상거래법 시행령 제6조 https://www.law.go.kr/법령/전자상거래등에서의소비자보호에관한법률시행령 |
| L9 | 부가세 증빙 | 매출: 쿠팡이 신용카드 등 결제 매출 자료를 국세청에 통보(확인 필요). 매입: 공급처 **전자세금계산서**(오너클랜·도매꾹 발행 방식 확인). 쿠팡 수수료는 쿠팡 발행 세금계산서. 면세 상품(농산물 등)은 별도 처리 | 국세청 https://www.nts.go.kr , 홈택스 |
| L10 | 상표권·저작권 | 상세이미지 재사용 허락 범위(공급처 약관), 상표 키워드 사용 | 특허정보검색 KIPRIS https://www.kipris.or.kr / [2차] https://www.lawtalk.co.kr/posts/161695 |

---

## 미확인 항목 요약 → 설계에서 config/어댑터로 처리

| ID | 항목 | 대응 |
|---|---|---|
| U1 | 쿠팡 rate limit 정확한 수치 | `COUPANG_RPS` config(기본 2), `X-CAG-Warnings` 기반 적응형 감속 |
| U2 | 현행 카테고리별 수수료율 | `fee_rates` 테이블 + 카테고리 오버라이드, 출처·확인일 컬럼. Wing에서 확인해 1회 입력 |
| U3 | 배송비 수수료율·월 서비스이용료 | config(3.3%, 55,000원, 출처 [2차] 주석) |
| U4 | 판매자 점수 임계값 | 자체 보수적 SLA(출고 D+1 이내, 취소율 목표 < 1%)로 가드 |
| U5 | 아이템위너·경쟁가 | API 불가 → 네이버 쇼핑 최저가를 대리 지표로 쓰고, 쿠팡 경쟁가는 수동 입력 필드 |
| U6 | 오너클랜 결제 흐름·잔액 조회 | 샌드박스 검증 전까지 `PAYMENT_MODE=approve_tap` |
| U7 | 공급처 호출 한도 | 어댑터별 rate limiter config |
| U8 | 이미지 재사용 허락 | 공급처별 `image_reuse_allowed` 플래그. 기본 false → 자체 상세페이지 생성 경로 |
| U9 | 상품명·썸네일 금지 문구 | `banned_terms` config + 운영 중 갱신 |
| U10 | 쿠팡 판매량 툴 CSV 포맷 | 파서 어댑터. 실제 파일을 받아 구현 |
| U11 | 검색광고 API 호출 한도 | 보수적 1 rps + 캐시(월 1회 갱신) |
| U12 | 쿠팡 약관 원문(재판매·개인정보·자동화 조항) | 사람이 직접 확인(로그인 브라우저) |
