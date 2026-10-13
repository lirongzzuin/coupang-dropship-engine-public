import type { CoupangPartnersClient } from './coupang/partners.js';
import type { GoogleTrendsClient } from './google/trends.js';
import type { NaverClient } from './naver/client.js';
import type { ElevenstSearchClient } from './elevenst/search.js';
import type { CoupangSearchSignal, MarketDataProvider, MarketSearchResult, RelatedKeyword } from '../ports/misc.js';

/** 여러 데이터 소스를 하나의 MarketDataProvider 로 조합. 없는 소스는 null 을 돌려준다. */
export class CompositeMarketData implements MarketDataProvider {
  constructor(
    private readonly naver: NaverClient,
    private readonly google?: GoogleTrendsClient,
    private readonly partners?: CoupangPartnersClient,
    private readonly market?: ElevenstSearchClient,
  ) {}

  async shoppingSearch(keyword: string): Promise<MarketSearchResult | null> {
    return this.market ? this.market.shoppingSearch(keyword) : null;
  }
  monthlySearchVolume(keywords: string[]): Promise<Record<string, number> | null> {
    return this.naver.monthlySearchVolume(keywords);
  }
  weeklyTrend(keyword: string, weeks: number): Promise<number[] | null> {
    return this.naver.weeklyTrend(keyword, weeks);
  }
  keywordStats(hints: string[]): Promise<RelatedKeyword[] | null> {
    return this.naver.keywordStats(hints);
  }
  relatedKeywords(seed: string): Promise<RelatedKeyword[] | null> {
    return this.naver.relatedKeywords(seed);
  }
  async googleTrend(keyword: string): Promise<number[] | null> {
    return this.google ? this.google.weeklyTrend(keyword) : null;
  }
  async coupangSearch(keyword: string): Promise<CoupangSearchSignal | null> {
    return this.partners ? this.partners.searchSignal(keyword) : null;
  }
}
