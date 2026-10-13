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
      minProfitKrw: z.number().int().default(2000),
      minMarginRate: z.number().default(0.1),
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
      seedKeywords: z.array(z.string()).default([]),
      sources: z.array(z.string()).default(['ownerclan', 'domeggook']),
      perKeywordLimit: z.number().int().default(20),
      topNotify: z.number().int().default(5),
      /** 공급가 하한(저가 상품은 배송비 고정비로 불리 — feasibility.md 2-3) */
      minSupplyPrice: z.number().int().default(15000),
      maxSupplyPrice: z.number().int().default(200000),
      minStock: z.number().int().default(10),
      /** 시장가(네이버 최저가) 대비 허용 초과율. 0 = 최저가 이하여야 통과 */
      competitiveTolerance: z.number().default(0),
      /** 시장가를 모를 때 탈락시킬지 */
      requireMarketPrice: z.boolean().default(true),
      /** 상표·브랜드 리스크 키워드(포함 시 탈락) */
      blockedKeywords: z
        .array(z.string())
        .default(['정품', '명품', '나이키', '아디다스', '샤넬', '구찌', '루이비통', '디즈니', '포켓몬', '산리오', '레고', '애플', '삼성', '다이슨']),
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
          margin: z.number().default(0.15),
          supplier: z.number().default(0.05),
          coupangSales: z.number().default(0.0),
        })
        .default({}),
    })
    .default({}),

  listing: z
    .object({
      /** 쿠팡 상품명 금지 문구 [2차] 2026-06 정책 관련 셀러 자료 (확인 2026-10-13) */
      bannedTerms: z
        .array(z.string())
        .default(['무료배송', '할인', '세일', '최저가', '특가', '특별가', '한정수량', '신상', '인기상품', '1+1', '당일출고', '당일발송', '국내발송', '묶음배송', '고급', '고품질', '본사정품', '최신', '지금구매', '이벤트']),
      maxTitleLength: z.number().int().default(100),
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
