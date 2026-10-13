import type { Logger } from '../../lib/logger.js';
import { HttpError, RateLimiter, retry } from '../../lib/util.js';
import { buildAuthorization } from './hmac.js';

export interface CoupangClientOptions {
  baseUrl: string;
  vendorId: string;
  accessKey: string;
  secretKey: string;
  requestsPerSecond: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** 429 수신 시 전체 호출 정지 시간(기본 60초) */
  throttlePenaltyMs?: number;
  /** X-CAG-Warnings(임계치 근접) 수신 시 감속 시간(기본 2초) */
  warningPenaltyMs?: number;
  /** 재시도 기본 대기(기본 1초, 지수 증가) */
  retryBaseMs?: number;
}

/**
 * 쿠팡 HTTP 클라이언트: 서명 + 전역 rate limit + 429/5xx 백오프.
 * 속도제한 정책: vendorId별 초당 제한, 초과 시 429. 지속 과호출은 영구 차단 가능
 * (https://developers.coupang.com/hc/ko/articles/23902034110617, 확인 2026-10-13).
 */
export class CoupangClient {
  readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: CoupangClientOptions) {
    this.limiter = new RateLimiter(opts.requestsPerSecond);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get vendorId(): string {
    return this.opts.vendorId;
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') qs.append(k, String(v));
    const query = qs.toString();
    return retry(
      async () => {
        await this.limiter.take();
        const auth = buildAuthorization({ method, path, query, accessKey: this.opts.accessKey, secretKey: this.opts.secretKey });
        const url = `${this.opts.baseUrl}${path}${query ? `?${query}` : ''}`;
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: auth,
            'Content-Type': 'application/json;charset=UTF-8',
            'X-Requested-By': this.opts.vendorId,
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(30_000),
        });
        const warn = res.headers.get('x-cag-warnings');
        if (warn) {
          // 임계치 근접 경고 → 자발적 감속
          this.opts.logger.warn({ warn, path }, 'coupang throttling warning');
          this.limiter.penalize(this.opts.warningPenaltyMs ?? 2_000);
        }
        const text = await res.text();
        let json: any = undefined;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = { raw: text };
        }
        if (res.status === 429) {
          this.limiter.penalize(this.opts.throttlePenaltyMs ?? 60_000);
          throw new HttpError(429, 'coupang rate limited (429)', json);
        }
        if (!res.ok) {
          const msg = json?.message ?? json?.raw ?? res.statusText;
          throw new HttpError(res.status, `coupang ${method} ${path} → ${res.status}: ${msg}`, json);
        }
        return json as T;
      },
      {
        attempts: 3,
        baseMs: this.opts.retryBaseMs ?? 1000,
        retryable: (e) => e instanceof HttpError && (e.status === 429 || e.status >= 500),
      },
    );
  }
}

/** v5 금액 객체 {units, nanos} 또는 숫자를 원 단위 정수로 */
export function money(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Math.round(v);
  if (typeof v === 'string') return Math.round(Number(v) || 0);
  if (typeof v === 'object' && 'units' in (v as any)) return Math.round(Number((v as any).units) + Number((v as any).nanos ?? 0) / 1e9);
  return 0;
}
