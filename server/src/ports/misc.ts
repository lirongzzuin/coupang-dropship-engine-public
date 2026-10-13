/** 알림 채널 */
export interface Notifier {
  send(msg: { level: 'info' | 'warn' | 'error' | 'action'; title: string; body: string; link?: string }): Promise<boolean>;
}

/** 시장 데이터 제공자. 설정되지 않았으면 null 반환(=신호 없음) */
export interface MarketSearchResult {
  total: number;
  items: Array<{ title: string; price: number; mall: string; productId: string; link: string; image?: string; productType?: number }>;
}

export interface MarketDataProvider {
  /** 네이버 쇼핑 검색: 시장가·경쟁 수 */
  shoppingSearch(keyword: string): Promise<MarketSearchResult | null>;
  /** 월간 검색량(절대값) */
  monthlySearchVolume(keywords: string[]): Promise<Record<string, number> | null>;
  /** 주간 상대 추세(0~100) 최근 N주 */
  weeklyTrend(keyword: string, weeks: number): Promise<number[] | null>;
}

/** 이미지 등 파일 저장소(로컬 디스크 → R2/S3 교체 가능) */
export interface ObjectStorage {
  put(key: string, data: Buffer, contentType: string): Promise<string>;
  get(key: string): Promise<{ data: Buffer; contentType: string } | null>;
  publicUrl(key: string): string;
}
