import type { Logger } from '../../lib/logger.js';
import { RateLimiter } from '../../lib/util.js';

/**
 * 구글 트렌드(보조 지표). 공식 API는 2026-10 현재 신청자 대상 알파라 trends.google.com 의
 * 공개 웹 데이터(explore → widgetdata/multiline)를 사용한다. 비공식이므로:
 *  - 실패해도 선정은 계속(신호 없음 처리), 429면 1시간 쉬고
 *  - 키워드당 하루 1회만 조회(캐시), 요청 간 8초 간격
 *  - 한국 쇼핑 키워드는 데이터가 희소(0이 많음)할 수 있어, 0이 아닌 값이 30% 미만이면 무시
 * 확인: 2026-10-13 이 Mac(가정용 IP)에서 정상 응답 확인.
 */
export interface GoogleTrendsOptions {
  logger: Logger;
  fetchImpl?: typeof fetch;
  geo?: string;
  cache?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
  now?: () => Date;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

export class GoogleTrendsClient {
  private readonly limiter = new RateLimiter(1 / 8);
  private cookie = '';
  private blockedUntil = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GoogleTrendsOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** 최근 약 12개월 주간 값(0~100). 데이터가 부족하면 null */
  async weeklyTrend(keyword: string): Promise<number[] | null> {
    const key = `gtrends:${this.opts.geo ?? 'KR'}:${keyword}`;
    const cached = (await this.opts.cache?.get(key)) as { at: string; series: number[] | null } | undefined;
    if (cached && this.now().getTime() - new Date(cached.at).getTime() < 24 * 3600_000) return cached.series;
    if (Date.now() < this.blockedUntil) return null;
    let series: number[] | null = null;
    try {
      series = await this.fetchSeries(keyword);
    } catch (e) {
      this.opts.logger.warn({ keyword, err: String(e) }, '구글 트렌드 조회 실패(무시)');
      return null;
    }
    if (series && series.filter((v) => v > 0).length < series.length * 0.3) series = null; // 희소 → 무시
    await this.opts.cache?.set(key, { at: this.now().toISOString(), series });
    return series;
  }

  private async get(url: string): Promise<Response> {
    await this.limiter.take();
    const res = await this.fetchImpl(url, { headers: { 'User-Agent': UA, ...(this.cookie ? { cookie: this.cookie } : {}) }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 429) {
      this.blockedUntil = Date.now() + 3600_000;
      throw new Error('구글 트렌드 429(요청 과다) — 1시간 휴식');
    }
    return res;
  }

  private async fetchSeries(keyword: string): Promise<number[] | null> {
    const geo = this.opts.geo ?? 'KR';
    if (!this.cookie) {
      const r0 = await this.get(`https://trends.google.com/trends/?geo=${geo}`);
      const sc = (r0.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      this.cookie = sc.map((c) => c.split(';')[0]).join('; ');
    }
    const req = { comparisonItem: [{ keyword, geo, time: 'today 12-m' }], category: 0, property: '' };
    const r1 = await this.get(`https://trends.google.com/trends/api/explore?hl=ko&tz=-540&req=${encodeURIComponent(JSON.stringify(req))}`);
    if (!r1.ok) throw new Error(`explore ${r1.status}`);
    const widgets: any[] = parseGoogleJson(await r1.text()).widgets ?? [];
    const w = widgets.find((x) => x.id === 'TIMESERIES');
    if (!w) return null;
    const r2 = await this.get(`https://trends.google.com/trends/api/widgetdata/multiline?hl=ko&tz=-540&req=${encodeURIComponent(JSON.stringify(w.request))}&token=${encodeURIComponent(w.token)}`);
    if (!r2.ok) throw new Error(`multiline ${r2.status}`);
    const data = parseGoogleJson(await r2.text());
    const pts: number[] = (data.default?.timelineData ?? []).map((p: any) => Number(p.value?.[0]) || 0);
    return pts.length ? pts : null;
  }
}

/** 구글 응답 앞의 )]}' 같은 보호 접두어 제거 */
export function parseGoogleJson(text: string): any {
  const i = text.indexOf('{');
  return JSON.parse(i >= 0 ? text.slice(i) : text);
}
