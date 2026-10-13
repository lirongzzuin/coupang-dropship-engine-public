/** 알림 채널 */
export interface Notifier {
  send(msg: { level: 'info' | 'warn' | 'error' | 'action'; title: string; body: string; link?: string }): Promise<boolean>;
}

/** 시장 데이터 제공자. 설정되지 않았으면 null 반환(=신호 없음) */
export interface MarketSearchResult {
  /** 시장 출처 라벨(예: 11번가) */
  source?: string;
  total: number;
  items: Array<{ title: string; price: number; mall: string; productId: string; link: string; image?: string; productType?: number }>;
}

export interface RelatedKeyword {
  keyword: string;
  /** 월간 검색량(PC+모바일) */
  volume: number;
  /** 광고 경쟁 정도: 낮음 | 중간 | 높음 */
  competition: string;
}

export interface CoupangSearchSignal {
  lowest: number;
  median: number;
  rocketRatio: number;
  count: number;
}

/**
 * 시장 데이터 제공자. 각 신호는 선택 사항이며 설정되지 않았거나 실패하면 null(=신호 없음).
 * 새 데이터 소스는 이 인터페이스에 메서드를 추가하고 CompositeMarketData 에서 조합한다.
 */
export interface MarketDataProvider {
  /** 오픈마켓 검색(시장가·경쟁 상품 수). 네이버 쇼핑 API 종료(2026-07-31) → 11번가 등 */
  shoppingSearch(keyword: string): Promise<MarketSearchResult | null>;
  /** 월간 검색량(절대값) — 네이버 검색광고 */
  monthlySearchVolume(keywords: string[]): Promise<Record<string, number> | null>;
  /** 주간 상대 추세(0~100) — 네이버 데이터랩(사용 가능할 때) */
  weeklyTrend(keyword: string, weeks: number): Promise<number[] | null>;
  /** 연관 키워드 — 네이버 검색광고 */
  relatedKeywords?(seed: string): Promise<RelatedKeyword[] | null>;
  /** 힌트 키워드(최대 5개)의 검색량·경쟁도 + 연관 키워드 전체 — 네이버 검색광고 */
  keywordStats?(hints: string[]): Promise<RelatedKeyword[] | null>;
  /** 구글 트렌드 주간 값(보조) */
  googleTrend?(keyword: string): Promise<number[] | null>;
  /** 쿠팡 검색 상위 상품 가격·로켓 비율 — 쿠팡 파트너스(선택) */
  coupangSearch?(keyword: string): Promise<CoupangSearchSignal | null>;
}

/** 이미지 등 파일 저장소(로컬 디스크 → R2/S3 교체 가능) */
export interface ObjectStorage {
  put(key: string, data: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;
  publicUrl(key: string): string;
}
