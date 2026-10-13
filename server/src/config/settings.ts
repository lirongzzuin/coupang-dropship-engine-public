import { z } from 'zod';

/**
 * 사업 파라미터. DB settings 테이블(key='app')에 JSON으로 저장되고 관리자 웹에서 수정한다.
 * 아래 기본값의 수치에는 출처와 확인일을 남긴다(docs/research.md 참고).
 * 바뀔 수 있는 정책 값은 전부 여기에 둔다. 코드에 하드코딩 금지.
 */

const feeRate = z.object({
  /** 카테고리 이름 접두(예: "생활용품" 또는 "생활용품>수납") — 가장 긴 접두가 우선 */
  match: z.string(),
  /** 판매수수료율(VAT 별도), 0.108 = 10.8% */
  rate: z.number().min(0).max(0.5),
  source: z.string().default(''),
});

export const settingsSchema = z.object({
  fees: z
    .object({
      /**
       * 쿠팡 판매수수료(VAT 별도). 출처: https://cloud.mkt.coupang.com/Fee-Table ("2019-11-25 기준", 2026-10-13 확인).
       * 2024~2026 셀러 자료와 동일. 현행값은 Wing에서 재확인 후 수정.
       */
      defaultRate: z.number().default(0.108),
      categoryRates: z.array(feeRate).default([
        { match: '가전디지털', rate: 0.078, source: 'Fee-Table 2019-11-25 (확인 2026-10-13)' },
        { match: '생활용품', rate: 0.078, source: 'Fee-Table 2019-11-25 (확인 2026-10-13)' },
        { match: '뷰티', rate: 0.096, source: 'Fee-Table 2019-11-25 (확인 2026-10-13)' },
        { match: '출산/유아', rate: 0.1, source: 'Fee-Table 2019-11-25 (확인 2026-10-13)' },
        { match: '자동차용품', rate: 0.1, source: 'Fee-Table 2019-11-25 (확인 2026-10-13)' },
        { match: '패션', rate: 0.105, source: 'Fee-Table 2019-11-25 (확인 2026-10-13)' },
        { match: '식품', rate: 0.106, source: 'Fee-Table 2019-11-25 (확인 2026-10-13)' },
        { match: '가구/홈인테리어', rate: 0.108, source: 'Fee-Table 2019-11-25 (확인 2026-10-13)' },
        { match: '주방용품', rate: 0.108, source: 'Fee-Table 2019-11-25 (확인 2026-10-13)' },
        { match: '문구/사무용품', rate: 0.108, source: 'Fee-Table 2019-11-25 (확인 2026-10-13)' },
        { match: '스포츠/레저용품', rate: 0.108, source: 'Fee-Table 2019-11-25 (확인 2026-10-13)' },
        { match: '완구/취미', rate: 0.108, source: 'Fee-Table 2019-11-25 (확인 2026-10-13)' },
        { match: '반려/애완용품', rate: 0.108, source: 'Fee-Table 2019-11-25 (확인 2026-10-13)' },
      ]),
      /** 수수료에 붙는 VAT. 정산 API serviceFeeVat 존재로 확인(2026-10-13) */
      feeVatRate: z.number().default(0.1),
      /** 고객 부담 배송비에 대한 수수료. [2차] windly.cc 3.3% (공식 미확인) */
      shippingFeeRate: z.number().default(0.033),
      /** 월 서비스이용료. [2차] 월매출 100만원 이상 55,000원 (공식 미확인) */
      monthlyServiceFee: z.number().default(55000),
      /** 건당 배분할 월 고정비 추정 주문수 */
      expectedMonthlyOrders: z.number().int().positive().default(100),
    })
    .default({}),

  pricing: z
    .object({
      minProfitKrw: z.number().int().default(3000),
      minMarginRate: z.number().default(0.12),
      /** 반품 충당률(판매가 대비) */
      returnReserveRate: z.number().default(0.03),
      /** 매입 세금계산서로 매입세액 공제 가능 여부 기본값(소스 판매자 유형으로 덮어씀) */
      inputVatDeductibleDefault: z.boolean().default(true),
      /** 가격 올림 단위 */
      roundUnit: z.number().int().default(100),
      /** 하루 가격 변경 최대 횟수(상품별) */
      maxPriceChangesPerDay: z.number().int().default(2),
      /** 1회 가격 변동 최대 비율(쿠팡 API 한도 −50%/+100% 보다 보수적으로) */
      maxChangeRatioDown: z.number().default(0.2),
      maxChangeRatioUp: z.number().default(0.5),
      /** 공급가 하락 시 판매가도 내릴지 */
      autoLowerPrice: z.boolean().default(false),
      /** 할인율 표시용 정가 = 판매가 × 배수 */
      originalPriceMultiplier: z.number().default(1.0),
      /** 가격 끝자리: '900' = 1만원 이상은 ○,900원 / 미만은 ○○90원(예: 22,400 → 22,900), 'none' = roundUnit 올림 */
      charmEnding: z.enum(['900', 'none']).default('900'),
      /** 경쟁가 정보가 없을 때 시작 마크업(하한가 대비) */
      defaultMarkup: z.number().default(0.15),
      /** 마크업 상한(하한가 대비) — 경쟁가를 모를 때 상품성을 지키는 상한 */
      maxMarkup: z.number().default(0.3),
      /**
       * 경쟁가와의 간격 중 가져올 비율(0~1). 목표가 = 하한가 + 비율 × (경쟁가×(1−undercut) − 하한가).
       * 0.5 = 중간 지점: 경쟁가보다 확실히 싸면서(아이템위너) 마진도 확보
       */
      gapCapture: z.number().min(0).max(1).default(0.5),
      /** 출시 기간(일): 신상품은 초기 판매·리뷰가 노출을 좌우 → 낮은 가격으로 시작 */
      launchDays: z.number().default(10),
      /** 출시 기간 마크업(하한가 대비) */
      launchMarkup: z.number().default(0.05),
      /** 경쟁 최저가가 있으면 그보다 이만큼 낮게 시작(아이템위너는 판매가+배송비 최저 우선) */
      undercutRate: z.number().default(0.01),
      /**
       * 묶음 수량 옵션(공급처가 여러 개를 한 상자·배송비 1회로 보낼 때만). 배송비가 1회라 단위가격↓·객단가↑
       * 예: [1,2,3] → "1개/2개/3개" 옵션
       */
      bundleUnits: z.array(z.number().int().min(1).max(10)).default([1, 2, 3]),
    })
    .default({}),

  /** 가격 자동 최적화(판매 결과로 마크업을 오르내리며 하루 이익을 최대화) */
  optimizer: z
    .object({
      enabled: z.boolean().default(true),
      /** 가격을 바꾼 뒤 판단까지 최소 관찰 기간(일) */
      observeDays: z.number().default(3),
      /** 관찰 기간 주문이 이 건수 이상이면 가격 인상 시도 */
      raiseMinOrders: z.number().int().default(2),
      stepUp: z.number().default(0.03),
      /** 인상 조건: 이번 기간 판매 속도가 직전 기간의 이 비율 이상(판매가 줄고 있으면 인상 보류) */
      velocityGuard: z.number().default(0.8),
      stepDown: z.number().default(0.04),
      /** 인상 후 하루 이익이 최고 기록의 이 비율 미만이면 최고 가격으로 되돌림 */
      revertRatio: z.number().default(0.6),
      /** 판매 없음으로 보고 인하하기까지 기간(일) */
      noSaleDays: z.number().default(5),
    })
    .default({}),

  /** 더 싼 동일 상품 자동 탐색(같은 공급처 안, 상품명 동일) */
  costScout: z
    .object({
      enabled: z.boolean().default(true),
      intervalDays: z.number().default(7),
      /** 원가(상품+배송비)가 이 비율 이상 싸야 교체 */
      minSaving: z.number().default(0.03),
    })
    .default({}),

  selection: z
    .object({
      /** auto: 게이트 통과 상위 후보를 자동 등록 | manual_approve: 관리자 승인 후 등록 */
      mode: z.enum(['auto', 'manual_approve']).default('auto'),
      /** auto 모드에서 1회 실행당 자동 등록 최대 수 */
      autoListPerRun: z.number().int().default(3),
      /** auto 모드 자동 등록 최소 점수(0~1) */
      autoListMinScore: z.number().default(0.4),
      /**
       * 무인 운영을 위해 API 자동 발주가 가능한 공급처 상품만 자동 등록.
       * false면 구매대행 작업함(사람 결제)이 필요한 상품도 자동 등록됨.
       */
      autoListRequiresApiOrder: z.boolean().default(true),
      /** auto: API 데이터로 키워드를 자동 발굴·순환(수동 시드는 고정 키워드로 함께 사용) | manual: 시드 키워드만 */
      keywordMode: z.enum(['auto', 'manual']).default('auto'),
      seedKeywords: z.array(z.string()).default([]),
      /** 시드 키워드마다 네이버 검색광고 연관 키워드를 몇 개까지 자동 추가할지(0=끔) */
      expandRelatedPerSeed: z.number().int().default(5),
      /** 연관 키워드 최소 월간 검색량 */
      relatedMinVolume: z.number().int().default(1000),
      /** 연관 키워드 최대 검색량(너무 큰 대형 키워드는 경쟁 과열) */
      relatedMaxVolume: z.number().int().default(200000),
      /** 광고 경쟁이 '높음'인 연관 키워드 제외 */
      relatedExcludeHighCompetition: z.boolean().default(true),
      sources: z.array(z.string()).default(['ownerclan', 'domeggook']),
      perKeywordLimit: z.number().int().default(20),
      topNotify: z.number().int().default(5),
      /** 같은 키워드로 동시에 운영할 최대 상품 수(분산) */
      maxPerKeyword: z.number().int().default(2),
      /** 최종 우선순위 비중: 기대 월이익 · 기대 월판매(잘 팔리는 상품) · 품질 */
      rankWeights: z.object({ profit: z.number().default(0.5), sales: z.number().default(0.2), quality: z.number().default(0.3) }).default({}),
      /** 수요 모델 계수(docs/selection-model.md) */
      model: z
        .object({
          baseSalesPer10k: z.number().default(1.5),
          volumeExponent: z.number().default(0.6),
          brandFactor: z.number().default(0.6),
          bulkFactor: z.number().default(0.5),
          refPrice: z.number().default(15000),
          priceElasticity: z.number().default(0.8),
        })
        .default({}),
      /** 공급가 하한(저가 상품은 배송비 고정비로 불리 — feasibility.md 2-3) */
      /** 1만원대 이하 생활용품까지 후보에 포함(배송비 포함 판매가 약 1.1만원~) */
      minSupplyPrice: z.number().int().default(2000),
      maxSupplyPrice: z.number().int().default(100000),
      minStock: z.number().int().default(10),
      /** 상품성: 공급처 출고 준비일 상한(쿠팡 도착예정일·정시출고에 직결). 초과 시 탈락 */
      maxPrepDays: z.number().int().default(3),
      /** 상품성: 공급처 판매자 만족도(%) 하한 — 후기 10건 이상일 때만 적용 */
      minSellerScore: z.number().default(85),
      /** 시장가(네이버 최저가) 대비 허용 초과율. 0 = 최저가 이하여야 통과 */
      competitiveTolerance: z.number().default(0),
      /** 시장가를 모를 때 탈락시킬지 */
      requireMarketPrice: z.boolean().default(false),
      /** 상표·브랜드 리스크 키워드(포함 시 탈락) */
      blockedKeywords: z
        .array(z.string())
        .default([
          '정품', '명품', '병행수입', '나이키', '아디다스', '샤넬', '구찌', '루이비통', '디즈니', '포켓몬', '산리오', '레고', '애플', '삼성', '다이슨',
          '유니클로', '자라', '노스페이스', '뉴발란스', '폴로', '타미힐피거', '몽클레어', '버버리', '프라다', '에르메스', '디올', '발렌시아가', '생로랑',
          '셀린느', '미우미우', '코치', '마이클코어스', 'MLB', '휠라', '푸마', '아식스', '컨버스', '반스', '크록스', '닥터마틴', '캘빈클라인', '라코스테',
          '스투시', '슈프림', '카카오프렌즈', '라인프렌즈', '짱구', '헬로키티', '마블', '스누피', '미키마우스', '젠틀몬스터', '다이소', '이케아', '무인양품',
          '스탠리', '코베아', '헬리녹스', '스노우피크', '콜맨', '로지텍', '샤오미', '필립스', '테팔', '쿠쿠', '락앤락', '써모스', '지프', '캉골', '데상트',
          // 생활·위생용품 대표 브랜드(상표권)
          '가그린', '리스테린', '페브리즈', '다우니', '피죤', '질레트', '오랄비', '센소다인', '페리오', '2080', '하기스', '하기스', '크리넥스', '깨끗한나라',
          '유한락스', '홈스타', '스카치', '3M', '포스트잇', '모나미', '스테들러', '파버카스텔', '제브라', '파일럿', '유니볼', '라미', '몰스킨',
          '코렐', '해피콜', '키친아트', '실리트', '휘슬러', '조셉조셉', '브라운', '오쏘몰', '닥터지',
        ]),
      /** 인증 필요/금지 카테고리 키워드(쿠팡 판매불가·인증필요 안내, 확인 2026-10-13) */
      blockedCategoryKeywords: z
        .array(z.string())
        .default(['의약', '의료기기', '건강기능식품', '주류', '담배', '전자담배', '콘택트렌즈', '농약', '성인', '도검', '총포']),
      /** 이 키워드가 카테고리/상품명에 있으면 KC 인증정보 필수 */
      kcSensitiveKeywords: z.array(z.string()).default(['전기', '충전', '어린이', '유아', '아동', '완구', '배터리', '어댑터', '조명', '히터']),
      weights: z
        .object({
          demand: z.number().default(0.3),
          trend: z.number().default(0.15),
          competition: z.number().default(0.15),
          priceAdvantage: z.number().default(0.2),
          margin: z.number().default(0.1),
          supplier: z.number().default(0.05),
          coupangSales: z.number().default(0.0),
          /** 구글 트렌드(보조, 한국 쇼핑 키워드는 희소) */
          googleTrend: z.number().default(0.05),
          /** 쿠팡 검색 상위의 로켓배송 비율이 낮을수록 유리 */
          rocketCompetition: z.number().default(0.05),
          /** 개당 이익 × 수요(검색량) — 실제로 돈이 되는 상품 우선 */
          profitPotential: z.number().default(0.2),
          /** 상품성: 빠른 출고(1일 이하 1.0 / 2일 0.6 / 3일 0.3) */
          fastShipping: z.number().default(0.1),
          /** 상품성: 상품 이미지 수(많을수록 상세 신뢰) */
          imageRichness: z.number().default(0.05),
          /** 상품성: 반품 가능 여부 */
          returnable: z.number().default(0.03),
          /** 진입 장벽: 상위 경쟁 상품 리뷰 수가 많을수록 불리(쿠팡 리뷰 CSV) */
          entryBarrier: z.number().default(0.05),
        })
        .default({}),
    })
    .default({}),

  /** 키워드 자동 발굴(공급처 인기 상품명·카테고리 → 네이버 검색광고 검색량 검증) */
  discovery: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * 발굴 대상 대분류(도매꾹 기준). 인증·허가·반품 위험이 큰 분류는 기본 제외:
       * 식품(영업신고), 디지털/가전(KC 전기), 출산·유아동(어린이제품 인증), 화장품, 건강용품(의료기기), 의류(사이즈 반품)
       */
      allowTopCategories: z.array(z.string()).default(['패션잡화', '가구/인테리어', '생활용품', '스포츠/레저', '문구']),
      /** 경로에 포함되면 제외할 카테고리 이름 */
      blockedCategoryNames: z.array(z.string()).default(['도서', '음반', '성인', '의약', '건강', '전기', '충전', '배터리', '유아', '아동', '완구']),
      categoriesPerRun: z.number().int().default(12),
      itemsPerCategory: z.number().int().default(60),
      phrasesPerCategory: z.number().int().default(6),
      /** 검색광고 조회 최대 힌트 수(5개씩 호출, 2초 간격) */
      maxHintsPerRun: z.number().int().default(80),
      minVolume: z.number().int().default(1000),
      maxVolume: z.number().int().default(150000),
      /** 점수가 가장 높은 월간 검색량(경쟁이 너무 세지 않은 적정 규모) */
      sweetSpotVolume: z.number().int().default(10000),
      excludeHighCompetition: z.boolean().default(true),
      poolMax: z.number().int().default(400),
      /** 상품 선정 1회에 쓰는 키워드 수(고정 키워드 포함) */
      keywordsPerRun: z.number().int().default(12),
      /** 같은 키워드를 다시 쓰기까지 간격(일) */
      reuseDays: z.number().int().default(7),
      /** 이 횟수만큼 써도 통과 후보가 없으면 자동 일시중지 */
      pauseAfterEmptyRuns: z.number().int().default(2),
      stopwords: z.array(z.string()).default([]),
      /** 구매 의도가 아닌 정보성·행사성 검색어(포함 시 제외) */
      noiseWords: z.array(z.string()).default([
        '추천', '후기', '리뷰', '가격', '비교', '순위', '브랜드', '사이트', '쇼핑몰', '쿠폰', '할인', '감사제', '이벤트', '세일', '맛집', '뜻', '방법', '만들기',
        '사용법', '중고', '렌탈', '대여', '수리', '직구', '도안', '사진', '영어로',
        // 상품이 아닌 금융·서비스·포털 검색어
        '홈페이지', '고객센터', '로그인', '어플', '신청', '발급', '혜택', '대출', '보험', '은행', '증권', '요금', '예약', '조회', '연락처', '채용', '주가',
        '신용카드', '체크카드', '카드사', '국민카드', '신한카드', '삼성카드', '현대카드', '롯데카드', '하나카드', '우리카드', 'BC카드', 'NH카드', '마스터카드', '비자카드',
        '쿠팡', '네이버', '카카오', '당근', '11번가', '지마켓', '옥션', '티몬', '위메프',
      ]),
      /** 연관 키워드는 원래 힌트·카테고리와 단어가 겹칠 때만 채택(엉뚱한 연관어 방지) */
      relatedRequireOverlap: z.boolean().default(true),
      /** 상품 카테고리 허용 목록(allowTopCategories)을 적용할 공급처(카테고리 체계가 같은 곳) */
      enforceCategoryForSources: z.array(z.string()).default(['domeggook']),
    })
    .default({}),

  listing: z
    .object({
      /** 쿠팡 상품명 금지 문구 [2차] 2026-06 정책 관련 셀러 자료 (확인 2026-10-13) */
      bannedTerms: z
        .array(z.string())
        .default(['무료배송', '할인', '세일', '최저가', '특가', '특별가', '한정수량', '신상', '인기상품', '1+1', '당일출고', '당일발송', '국내발송', '묶음배송', '고급', '고품질', '본사정품', '최신', '지금구매', '이벤트']),
      maxTitleLength: z.number().int().default(100),
      /** 하한가로 내린 뒤에도 이 기간 0건이면 판매종료 → 새 상품으로 교체 */
      stopAfterLowerDays: z.number().int().default(10),
      /** 공급처 이미지를 .jpg로 변환해 우리 서버(/media)에서 제공(쿠팡은 확장자 없는 URL·GIF 거부) */
      convertImages: z.boolean().default(true),
      maxTags: z.number().int().default(20),
      /** 출고소요일 = 소스 준비기간 + 버퍼 */
      shippingBufferDays: z.number().int().default(1),
      maxBuyPerPerson: z.number().int().default(0),
      /** 판매중지 판단: 등록 후 N일 판매 0 */
      zeroSaleDays: z.number().int().default(14),
      /** 동시 운영(탐색) 상품 수 상한 */
      maxActiveListings: z.number().int().default(30),
    })
    .default({}),

  coupang: z
    .object({
      vendorUserId: z.string().default(''),
      outboundShippingPlaceCode: z.string().default(''),
      returnCenterCode: z.string().default(''),
      returnChargeName: z.string().default(''),
      companyContactNumber: z.string().default(''),
      returnZipCode: z.string().default(''),
      returnAddress: z.string().default(''),
      returnAddressDetail: z.string().default(''),
      /** 반품 배송비(편도) */
      returnCharge: z.number().int().default(3000),
      deliveryCompanyCode: z.string().default('CJGLS'),
      /** 키 발급일(YYYY-MM-DD). 유효기간 180일 — 공식 확인 2026-10-13 */
      keyIssuedAt: z.string().default(''),
      keyValidDays: z.number().int().default(180),
      /** 초당 호출 상한(공식 수치 미공개 → 보수적) */
      requestsPerSecond: z.number().default(2),
      /** 주문 폴링 시 과거 겹침 구간(분) */
      orderPollOverlapMinutes: z.number().int().default(15),
    })
    .default({}),

  orders: z
    .object({
      /** approve: 구매 전 사람이 확인 | auto: API 가능한 소스는 자동 발주 */
      mode: z.enum(['approve', 'auto']).default('auto'),
      /** 공급처 주문의 보내는 사람(택배 송장에 표시) — 비우면 받는 분 이름·쿠팡 고객센터 번호 */
      senderName: z.string().default(''),
      senderPhone: z.string().default(''),
      perOrderMaxCost: z.number().int().default(100000),
      dailyMaxCost: z.number().int().default(500000),
      /** 구매 작업 미처리 경고(시간) */
      purchaseAlertHours: z.number().default(3),
      /** 구매 후 송장 미입력 경고(시간) */
      trackingAlertHours: z.number().default(36),
      /** 배송완료 후 개인정보 보관일 */
      piiRetentionDays: z.number().int().default(90),
      /** 택배사 이름 → 쿠팡 코드. 출처: developers.coupang.com/ko/api/logistics/courier-code (2026-10-13) */
      courierAliases: z.record(z.string()).default({
        CJ대한통운: 'CJGLS', 대한통운: 'CJGLS', CJ: 'CJGLS',
        롯데택배: 'HYUNDAI', 롯데: 'HYUNDAI', 현대택배: 'HYUNDAI',
        한진택배: 'HANJIN', 한진: 'HANJIN',
        로젠택배: 'KGB', 로젠: 'KGB',
        우체국택배: 'EPOST', 우체국: 'EPOST',
        경동택배: 'KDEXP', 대신택배: 'DAESIN', 일양로지스: 'ILYANG', 일양택배: 'ILYANG',
        천일택배: 'CHUNIL', 합동택배: 'HDEXP', CVS택배: 'CVS', GS편의점택배: 'CVS',
        농협택배: 'NHLOGIS', 건영택배: 'KUNYOUNG', 드림택배: 'DONGBU',
      }),
    })
    .default({}),

  cs: z
    .object({
      autoReplyTemplates: z.boolean().default(true),
      templates: z
        .array(z.object({ name: z.string(), keywords: z.array(z.string()), reply: z.string() }))
        .default([
          {
            name: 'delivery',
            keywords: ['배송', '언제', '도착', '송장', '출고'],
            reply: '안녕하세요, 문의 주셔서 감사합니다. 주문하신 상품은 순차적으로 출고되며, 출고 후 송장번호가 등록되면 쿠팡 주문내역에서 배송 조회가 가능합니다. 조금만 기다려 주시면 빠르게 보내드리겠습니다.',
          },
        ]),
    })
    .default({}),

  schedule: z
    .object({
      orderPollMinutes: z.number().default(5),
      fulfillmentMinutes: z.number().default(10),
      syncMinutes: z.number().default(60),
      listingStatusMinutes: z.number().default(30),
      csMinutes: z.number().default(30),
      reconcileHours: z.number().default(24),
      selectionHours: z.number().default(24),
      /** 키워드 자동 발굴 주기(시간) */
      discoveryHours: z.number().default(72),
      dailyReportHour: z.number().int().min(0).max(23).default(9),
      watchdogMinutes: z.number().default(10),
      /** 주문 폴링이 이 시간(분) 이상 성공하지 못하면 알림 */
      orderPollStaleMinutes: z.number().default(30),
    })
    .default({}),

  /** 긴급 정지: true면 외부 부작용(등록·가격·발주·송장·답변) 전부 중단, 감지는 계속 */
  killSwitch: z.boolean().default(false),
});

export type Settings = z.infer<typeof settingsSchema>;

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

/** 부분 업데이트를 깊게 병합한 뒤 검증 */
/**
 * 저장용: 기본값과 다른 값만 남긴다(사람이 바꾼 값만 DB에 → 이후 기본값 개선이 자동 적용).
 * 배열은 통째로 비교.
 */
export function diffSettings(value: unknown, base: unknown): unknown {
  if (Array.isArray(value) || value === null || typeof value !== 'object' || base === null || typeof base !== 'object' || Array.isArray(base)) {
    return JSON.stringify(value) === JSON.stringify(base) ? undefined : value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const d = diffSettings(v, (base as Record<string, unknown>)[k]);
    if (d !== undefined) out[k] = d;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 예전 버전은 설정 전체(당시 기본값 포함)를 저장했다. 사람이 고른 값이 아니라 옛 기본값이 남은 것으로 보고 지운다.
 * [경로, 옛 기본값]
 */
export const STALE_DEFAULTS: Array<[string, unknown]> = [
  ['pricing.minProfitKrw', 2000],
  ['pricing.minMarginRate', 0.1],
  ['pricing.defaultMarkup', 0.08],
  ['pricing.maxMarkup', 0.5],
  ['pricing.launchMarkup', 0.02],
  ['optimizer.stepUp', 0.04],
  ['selection.minSupplyPrice', 15000],
  ['selection.maxSupplyPrice', 200000],
];

export function dropStaleDefaults(stored: unknown): unknown {
  if (!stored || typeof stored !== 'object') return stored;
  const copy = JSON.parse(JSON.stringify(stored)) as Record<string, any>;
  for (const [path, old] of STALE_DEFAULTS) {
    const [sec, key] = path.split('.') as [string, string];
    if (copy[sec] && typeof copy[sec] === 'object' && JSON.stringify(copy[sec][key]) === JSON.stringify(old)) delete copy[sec][key];
  }
  return copy;
}

export function mergeSettings(current: Settings, patch: unknown): Settings {
  return settingsSchema.parse(deepMerge(current, patch));
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (b === undefined) return a;
  if (Array.isArray(b) || b === null || typeof b !== 'object') return b;
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return b;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    out[k] = deepMerge((a as Record<string, unknown>)[k], v);
  }
  return out;
}
