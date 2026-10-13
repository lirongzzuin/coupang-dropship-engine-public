import type { MarketDataProvider, MarketSearchResult } from '../../ports/misc.js';
import { MockSource } from './mockSource.js';

/**
 * DEMO_MODE: 키 없이 관리자 웹에서 전체 흐름을 체험하기 위한 가짜 공급처·시장 데이터.
 * (실운영에서는 사용되지 않음 — MARKET_ADAPTER=fake 일 때만 활성)
 */
export function demoSources(): MockSource[] {
  const auto = new MockSource('demo-auto', { apiOrder: true });
  const manual = new MockSource('demo-manual', { apiOrder: false });
  const items: Array<[MockSource, string, string, number]> = [
    [auto, 'DA1', '접이식 수납 정리함 대형 3단', 15900],
    [auto, 'DA2', '원목 수납 정리함 서랍형', 21000],
    [auto, 'DA3', '캠핑 접이식 의자 경량', 18500],
    [auto, 'DA4', '나이키 스타일 수납 정리함', 16000],
    [manual, 'DM1', '패브릭 수납 정리함 2개입', 15500],
    [manual, 'DM2', '캠핑 의자 릴렉스 체어', 26000],
  ];
  for (const [src, id, title, price] of items) {
    src.add({ sourceItemId: id, title, price, images: [`https://picsum.photos/seed/${id}/800/800`], imageUrl: `https://picsum.photos/seed/${id}/800/800` });
  }
  return [auto, manual];
}

export class DemoMarketData implements MarketDataProvider {
  async shoppingSearch(keyword: string): Promise<MarketSearchResult | null> {
    const base = keyword.includes('의자') ? 49000 : 42000;
    return { total: 1800, items: [{ title: keyword, price: base, mall: '데모몰', productId: 'demo', link: 'https://example.com' }] };
  }
  async monthlySearchVolume(keywords: string[]): Promise<Record<string, number>> {
    return Object.fromEntries(keywords.map((k) => [k, 12000 + k.length * 1000]));
  }
  async weeklyTrend(): Promise<number[]> {
    return [40, 42, 45, 44, 50, 55, 60, 62, 70, 75, 80, 100];
  }
}
