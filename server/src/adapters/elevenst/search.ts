import iconv from 'iconv-lite';
import type { Logger } from '../../lib/logger.js';
import { HttpError, RateLimiter } from '../../lib/util.js';
import type { MarketSearchResult } from '../../ports/misc.js';

/**
 * 11번가 오픈API 상품검색(시장 가격 참고용, 선택).
 * 네이버 쇼핑 검색 API는 2026-07-31 종료(실호출 404 SE05 확인, 2026-10-13) → 대체 시장가 소스.
 *  GET http://openapi.11st.co.kr/openapi/OpenApiService.tmall?key=&apiCode=ProductSearch&keyword=(EUC-KR)&pageSize=&sortCd=CP
 *  응답: EUC-KR XML (Products > TotalCount, Product > ProductName/ProductPrice/SalePrice/SellerNick/Delivery …)
 * 엔드포인트 생존은 확인(키 없이 호출 시 invalidOpenApiKey). 응답 필드는 키 발급 후 `check.sh`로 검증 필요.
 */
export interface ElevenstOptions {
  apiKey: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  cache?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  now?: () => Date;
}

const BASE = 'http://openapi.11st.co.kr/openapi/OpenApiService.tmall';

export class ElevenstSearchClient {
  private readonly limiter = new RateLimiter(1);
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: ElevenstOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async shoppingSearch(keyword: string): Promise<MarketSearchResult | null> {
    const ck = `11st:${keyword}`;
    const now = this.opts.now?.() ?? new Date();
    const cached = (await this.opts.cache?.get(ck)) as { at: string; v: MarketSearchResult | null } | undefined;
    if (cached && now.getTime() - new Date(cached.at).getTime() < 24 * 3600_000) return cached.v;
    const kw = [...iconv.encode(keyword, 'euc-kr')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
    await this.limiter.take();
    const res = await this.fetchImpl(`${BASE}?key=${encodeURIComponent(this.opts.apiKey)}&apiCode=ProductSearch&keyword=${kw}&pageNum=1&pageSize=50&sortCd=CP`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new HttpError(res.status, `11번가 검색 ${res.status}`);
    const xml = iconv.decode(Buffer.from(await res.arrayBuffer()), 'euc-kr');
    const v = parseElevenstSearch(xml);
    await this.opts.cache?.set(ck, { at: now.toISOString(), v });
    return v;
  }
}

const tag = (xml: string, name: string): string | undefined => {
  const m = xml.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`));
  return m?.[1]?.trim();
};
const num = (v: string | undefined): number => Number(String(v ?? '').replace(/[^\d]/g, '')) || 0;

export function parseElevenstSearch(xml: string): MarketSearchResult | null {
  const err = tag(xml, 'ErrorMessage');
  if (err) throw new Error(`11번가 오류: ${err}`);
  const products = [...xml.matchAll(/<Product>([\s\S]*?)<\/Product>/g)].map((m) => m[1]!);
  if (!products.length && !/<Products>/.test(xml)) return null;
  const items = products
    .map((p) => ({
      title: (tag(p, 'ProductName') ?? '').replace(/<[^>]+>/g, ''),
      // 할인가가 있으면 할인가, 없으면 정가
      price: num(tag(p, 'SalePrice')) || num(tag(p, 'ProductPrice')),
      mall: tag(p, 'SellerNick') ?? tag(p, 'Seller') ?? '',
      productId: tag(p, 'ProductCode') ?? '',
      link: tag(p, 'DetailPageUrl') ?? '',
      image: tag(p, 'ProductImage'),
    }))
    .filter((i) => i.price > 0);
  return { total: num(tag(xml, 'TotalCount')) || items.length, items, source: '11번가' };
}
