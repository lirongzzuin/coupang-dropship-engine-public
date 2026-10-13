import { createHmac } from 'node:crypto';
import type { Logger } from '../../lib/logger.js';
import { HttpError, RateLimiter, retry } from '../../lib/util.js';
import type { MarketDataProvider, MarketSearchResult } from '../../ports/misc.js';
import type { SourceAdapter, SourceProductDetail, SourceProductSummary } from '../../ports/source.js';

/**
 * 네이버 공식 API (확인 2026-10-13)
 * - 쇼핑 검색: GET https://openapi.naver.com/v1/search/shop.json (25,000회/일, display≤100)
 * - 데이터랩 통합검색어 트렌드: POST /v1/datalab/search (1,000회/일, 상대값)
 * - 검색광고 키워드도구: GET https://api.searchad.naver.com/keywordstool (HMAC)
 */
export interface NaverOptions {
  clientId?: string;
  clientSecret?: string;
  searchAd?: { customerId: string; apiKey: string; secret: string };
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export class NaverClient implements MarketDataProvider {
  private readonly limiter = new RateLimiter(5);
  private readonly adLimiter = new RateLimiter(1);
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: NaverOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get hasOpenApi(): boolean {
    return !!(this.opts.clientId && this.opts.clientSecret);
  }

  private async openapi(method: 'GET' | 'POST', path: string, query?: Record<string, string>, body?: unknown): Promise<any> {
    if (!this.hasOpenApi) return null;
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    return retry(async () => {
      await this.limiter.take();
      const res = await this.fetchImpl(`https://openapi.naver.com${path}${qs}`, {
        method,
        headers: {
          'X-Naver-Client-Id': this.opts.clientId!,
          'X-Naver-Client-Secret': this.opts.clientSecret!,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new HttpError(res.status, `naver ${path} ${res.status}`);
      return res.json();
    }, { attempts: 2, retryable: (e) => e instanceof HttpError && (e.status === 429 || e.status >= 500) });
  }

  async shoppingSearch(keyword: string): Promise<MarketSearchResult | null> {
    const d = await this.openapi('GET', '/v1/search/shop.json', { query: keyword, display: '100', start: '1', sort: 'sim', exclude: 'used:rental:cbshop' });
    if (!d) return null;
    return {
      total: Number(d.total) || 0,
      items: (d.items ?? []).map((it: any) => ({
        title: String(it.title ?? '').replace(/<[^>]+>/g, ''),
        price: Number(it.lprice) || 0,
        mall: String(it.mallName ?? ''),
        productId: String(it.productId ?? ''),
        link: String(it.link ?? ''),
        image: it.image ? String(it.image) : undefined,
        productType: it.productType ? Number(it.productType) : undefined,
      })),
    };
  }

  async weeklyTrend(keyword: string, weeks: number): Promise<number[] | null> {
    const end = new Date();
    const start = new Date(end.getTime() - weeks * 7 * 86400_000);
    const d = await this.openapi('POST', '/v1/datalab/search', undefined, {
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      timeUnit: 'week',
      keywordGroups: [{ groupName: keyword, keywords: [keyword] }],
    });
    if (!d) return null;
    return (d.results?.[0]?.data ?? []).map((x: any) => Number(x.ratio) || 0);
  }

  async monthlySearchVolume(keywords: string[]): Promise<Record<string, number> | null> {
    const ad = this.opts.searchAd;
    if (!ad) return null;
    const out: Record<string, number> = {};
    // hintKeywords 는 공백 제거 필요, 한 번에 최대 5개(공식 문서 SPA, 2차 자료 기준)
    for (let i = 0; i < keywords.length; i += 5) {
      const chunk = keywords.slice(i, i + 5).map((k) => k.replace(/\s+/g, ''));
      const path = '/keywordstool';
      const ts = String(Date.now());
      const sig = createHmac('sha256', ad.secret).update(`${ts}.GET.${path}`).digest('base64');
      await this.adLimiter.take();
      const res = await this.fetchImpl(`https://api.searchad.naver.com${path}?${new URLSearchParams({ hintKeywords: chunk.join(','), showDetail: '1' })}`, {
        headers: { 'X-Timestamp': ts, 'X-API-KEY': ad.apiKey, 'X-Customer': ad.customerId, 'X-Signature': sig },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new HttpError(res.status, `searchad keywordstool ${res.status}`);
      const d: any = await res.json();
      for (const k of d.keywordList ?? []) {
        const n = (v: unknown) => (typeof v === 'number' ? v : String(v).includes('<') ? 5 : Number(v) || 0);
        out[String(k.relKeyword)] = n(k.monthlyPcQcCnt) + n(k.monthlyMobileQcCnt);
      }
    }
    return out;
  }
}

/**
 * 네이버 쇼핑 상품을 공급처로 사용(구매대행 작업함 전용).
 * 상세 API가 없어 검색 결과에서 productId로 가격을 재확인한다.
 * 타 판매자 이미지는 저작물이므로 imageReuseAllowed=false (직접 제작 이미지 필요).
 */
export class NaverShoppingSource implements SourceAdapter {
  readonly id = 'naver';
  readonly displayName = '네이버쇼핑';
  readonly capabilities = { search: true, detail: true, apiOrder: false, apiTracking: false };
  private cache = new Map<string, { title: string; summary: SourceProductSummary }>();
  constructor(private readonly client: NaverClient) {}

  async search(keyword: string, opts: { limit?: number; minPrice?: number; maxPrice?: number } = {}): Promise<SourceProductSummary[]> {
    const r = await this.client.shoppingSearch(keyword);
    if (!r) return [];
    const list = r.items
      .filter((i) => i.productId && i.price > 0)
      .filter((i) => (!opts.minPrice || i.price >= opts.minPrice) && (!opts.maxPrice || i.price <= opts.maxPrice))
      .slice(0, opts.limit ?? 20)
      .map((i) => ({ sourceItemId: i.productId, title: i.title, url: i.link, imageUrl: i.image, price: i.price, shippingFee: 3000 }));
    for (const s of list) this.cache.set(s.sourceItemId, { title: s.title, summary: s });
    return list;
  }

  async getProduct(productId: string, hint?: { title?: string }): Promise<SourceProductDetail | null> {
    const title = hint?.title ?? this.cache.get(productId)?.title;
    if (!title) return null;
    const r = await this.client.shoppingSearch(title);
    const hit = r?.items.find((i) => i.productId === productId);
    if (!hit) return { sourceItemId: productId, title, url: '', price: 0, shippingFee: 0, status: 'ended', stock: null, imageReuseAllowed: false, images: [], taxInvoice: false };
    return {
      sourceItemId: productId,
      title: hit.title,
      url: hit.link,
      imageUrl: hit.image,
      price: hit.price,
      // 배송비는 검색 API에 없음 → 보수적으로 3,000원 가정(구매 시 실제값 입력으로 보정)
      shippingFee: 3000,
      status: 'active',
      stock: null,
      imageReuseAllowed: false,
      images: [],
      // 소매 구매는 현금영수증/카드 매입 → 세금계산서 없다고 보수적으로 가정
      taxInvoice: false,
    };
  }
}
