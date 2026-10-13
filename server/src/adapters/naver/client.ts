import { createHmac } from 'node:crypto';
import type { Logger } from '../../lib/logger.js';
import { HttpError, RateLimiter, retry } from '../../lib/util.js';
import type { RelatedKeyword } from '../../ports/misc.js';

/**
 * 네이버 공식 API (확인 2026-10-13)
 * - 쇼핑 검색 API는 2026-07-31 종료(호출 시 404 SE05) → 사용하지 않음. 시장가는 11번가·쿠팡 파트너스로 대체
 * - 데이터랩 통합검색어 트렌드: POST /v1/datalab/search (1,000회/일, 상대값)
 * - 검색광고 키워드도구: GET https://api.searchad.naver.com/keywordstool (HMAC)
 *   2025-09 광고계정 통합 이후 키는 '네이버 광고주센터(ads.naver.com)'에서 발급·확인 (릴리스노트 2026-07-02, 확인 2026-10-13)
 */
export interface NaverOptions {
  clientId?: string;
  clientSecret?: string;
  searchAd?: { customerId: string; apiKey: string; secret: string };
  /** 데이터랩(검색어트렌드) 사용 여부 — 앱에 권한이 있을 때만 true */
  datalabEnabled?: boolean;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export class NaverClient {
  private readonly limiter = new RateLimiter(5);
  /**
   * 키워드도구(RelKwdStat)는 다른 API 대비 1/5~1/6 속도 제한, IP 단위로도 제한.
   * 429 를 받으면 최소 5분 모든 호출 중단(공식 가이드 2020-12-18, 2026-10-13 재확인) → 2초 간격 + 5분 차단기
   */
  private readonly adLimiter = new RateLimiter(0.5);
  private adBlockedUntil = 0;
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

  async weeklyTrend(keyword: string, weeks: number): Promise<number[] | null> {
    if (!this.opts.datalabEnabled) return null;
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

  get hasSearchAd(): boolean {
    return !!this.opts.searchAd;
  }

  /** 검색광고 키워드도구 호출: hintKeywords(최대 5개, 공백 제거) → 입력 키워드 + 연관 키워드 목록 */
  private async keywordTool(hints: string[]): Promise<RelatedKeyword[]> {
    const ad = this.opts.searchAd!;
    const path = '/keywordstool';
    const ts = String(Date.now());
    const sig = createHmac('sha256', ad.secret).update(`${ts}.GET.${path}`).digest('base64');
    if (Date.now() < this.adBlockedUntil) throw new HttpError(429, '검색광고 키워드도구 호출 일시 중단(429 후 5분 대기)');
    await this.adLimiter.take();
    const res = await this.fetchImpl(`https://api.searchad.naver.com${path}?${new URLSearchParams({ hintKeywords: hints.map((k) => k.replace(/\s+/g, '')).join(','), showDetail: '1' })}`, {
      headers: { 'X-Timestamp': ts, 'X-API-KEY': ad.apiKey, 'X-Customer': ad.customerId, 'X-Signature': sig },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) {
      this.adBlockedUntil = Date.now() + 5 * 60_000;
      throw new HttpError(429, '검색광고 키워드도구 429 — 5분간 호출 중단');
    }
    if (res.status === 401 || res.status === 403) throw new HttpError(res.status, '검색광고 API 인증 실패 — 네이버 광고주센터(ads.naver.com)에서 API 키(비밀키) 확인·재발급 필요');
    if (!res.ok) throw new HttpError(res.status, `searchad keywordstool ${res.status}`);
    const d: any = await res.json();
    // 검색량이 적으면 "< 10" 문자열로 옴
    const n = (v: unknown) => (typeof v === 'number' ? v : String(v).includes('<') ? 5 : Number(v) || 0);
    return (d.keywordList ?? []).map((k: any) => ({ keyword: String(k.relKeyword), volume: n(k.monthlyPcQcCnt) + n(k.monthlyMobileQcCnt), competition: String(k.compIdx ?? '') }));
  }

  async monthlySearchVolume(keywords: string[]): Promise<Record<string, number> | null> {
    if (!this.opts.searchAd) return null;
    const out: Record<string, number> = {};
    for (let i = 0; i < keywords.length; i += 5) {
      const chunk = keywords.slice(i, i + 5);
      const list = await this.keywordTool(chunk);
      const wanted = new Set(chunk.map((k) => k.replace(/\s+/g, '')));
      for (const k of list) if (wanted.has(k.keyword.replace(/\s+/g, ''))) out[k.keyword] = k.volume;
    }
    return out;
  }

  async keywordStats(hints: string[]): Promise<RelatedKeyword[] | null> {
    if (!this.opts.searchAd) return null;
    return this.keywordTool(hints.slice(0, 5));
  }

  async relatedKeywords(seed: string): Promise<RelatedKeyword[] | null> {
    if (!this.opts.searchAd) return null;
    const self = seed.replace(/\s+/g, '');
    return (await this.keywordTool([seed])).filter((k) => k.keyword.replace(/\s+/g, '') !== self);
  }
}
