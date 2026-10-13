import type { Logger } from '../../lib/logger.js';
import { buildAuthorization } from './hmac.js';

/**
 * 쿠팡 파트너스 Open API(선택). 쿠팡 검색 상위 상품의 가격·로켓배송 여부 → 쿠팡 내 가격 경쟁력 판단.
 * - 엔드포인트: GET https://api-gateway.coupang.com/v2/providers/affiliate_open_api/apis/openapi/products/search?keyword=&limit=10
 *   인증은 판매자 API와 같은 CEA HMAC. (출처: 파트너스 연동 예제 codedosa.com/12603, 확인 2026-10-13 — 공식 문서는 파트너스 로그인 필요)
 * - 호출 제한: 검색 시간당 10회(2차 자료, 일부는 분당 50회) → 보수적으로 시간당 10회 + 키워드당 7일 캐시
 * - 이용 조건: 파트너스 가입·API 활성화(과거 기준 누적 실적 필요)와 파트너스 약관(제휴 목적 외 이용 제한 여부) 직접 확인 필요
 */
export interface CoupangSearchSignal {
  lowest: number;
  median: number;
  rocketRatio: number;
  count: number;
  top: Array<{ name: string; price: number; rocket: boolean; rank: number }>;
}

export interface PartnersOptions {
  accessKey: string;
  secretKey: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  maxPerHour?: number;
  cache?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  now?: () => Date;
}

const PATH = '/v2/providers/affiliate_open_api/apis/openapi/products/search';

export class CoupangPartnersClient {
  private calls: number[] = [];
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: PartnersOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** 시간당 호출 한도가 남았는지 */
  private quotaLeft(): boolean {
    const hourAgo = this.now().getTime() - 3600_000;
    this.calls = this.calls.filter((t) => t > hourAgo);
    return this.calls.length < (this.opts.maxPerHour ?? 10);
  }

  async searchSignal(keyword: string): Promise<CoupangSearchSignal | null> {
    const key = `cpartners:${keyword}`;
    const cached = (await this.opts.cache?.get(key)) as { at: string; v: CoupangSearchSignal | null } | undefined;
    if (cached && this.now().getTime() - new Date(cached.at).getTime() < 7 * 86400_000) return cached.v;
    if (!this.quotaLeft()) return null; // 다음 실행 때 이어서
    this.calls.push(this.now().getTime());
    const query = `keyword=${encodeURIComponent(keyword)}&limit=10`;
    try {
      const res = await this.fetchImpl(`https://api-gateway.coupang.com${PATH}?${query}`, {
        headers: {
          Authorization: buildAuthorization({ method: 'GET', path: PATH, query, accessKey: this.opts.accessKey, secretKey: this.opts.secretKey }),
          'Content-Type': 'application/json;charset=UTF-8',
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`partners ${res.status}`);
      const json: any = await res.json();
      const items: any[] = json?.data?.productData ?? [];
      const top = items
        .map((p) => ({ name: String(p.productName ?? ''), price: Number(p.productPrice) || 0, rocket: !!p.isRocket, rank: Number(p.rank) || 0 }))
        .filter((p) => p.price > 0);
      const prices = top.map((p) => p.price).sort((a, b) => a - b);
      const v: CoupangSearchSignal | null = prices.length
        ? { lowest: prices[0]!, median: prices[Math.floor(prices.length / 2)]!, rocketRatio: top.filter((p) => p.rocket).length / top.length, count: top.length, top }
        : null;
      await this.opts.cache?.set(key, { at: this.now().toISOString(), v });
      return v;
    } catch (e) {
      this.opts.logger.warn({ keyword, err: String(e) }, '쿠팡 파트너스 조회 실패(무시)');
      return null;
    }
  }
}
