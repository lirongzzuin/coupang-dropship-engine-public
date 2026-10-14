/** 공통 유틸: 시계, 날짜(KST), 금액, 재시도, rate limiter */

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** 테스트용으로 시간을 직접 움직이는 시계 */
export class ManualClock implements Clock {
  constructor(private t: Date) {}
  now(): Date {
    return new Date(this.t);
  }
  set(t: Date): void {
    this.t = new Date(t);
  }
  advanceMinutes(m: number): void {
    this.t = new Date(this.t.getTime() + m * 60_000);
  }
}

const KST_OFFSET_MS = 9 * 3600_000;

/** KST 기준 YYYY-MM-DD */
export function kstDate(d: Date): string {
  return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** KST 기준 시(0~23) */
export function kstHour(d: Date): number {
  return new Date(d.getTime() + KST_OFFSET_MS).getUTCHours();
}

/** KST 요일(0=일 … 6=토) */
export function kstWeekday(d: Date): number {
  return new Date(d.getTime() + KST_OFFSET_MS).getUTCDay();
}

/** 쿠팡 발주서 조회 형식: yyyy-MM-ddTHH:mm+09:00 */
export function kstIsoMinute(d: Date): string {
  const k = new Date(d.getTime() + KST_OFFSET_MS).toISOString();
  return `${k.slice(0, 16)}+09:00`;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400_000);
}

export function roundUp(value: number, unit: number): number {
  return Math.ceil(value / unit) * unit;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

/** 지수 백오프 재시도. retryable(err)=false면 즉시 throw */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; retryable?: (e: unknown) => boolean } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (opts.retryable && !opts.retryable(e)) throw e;
      if (i < attempts - 1) await sleep(base * 2 ** i + Math.floor(Math.random() * base));
    }
  }
  throw lastErr;
}

/** 단순 토큰버킷. 초당 rps 회로 직렬화 */
export class RateLimiter {
  private nextAt = 0;
  private penaltyUntil = 0;
  constructor(private rps: number) {}
  setRate(rps: number): void {
    this.rps = rps;
  }
  /** 429 등으로 감속이 필요할 때 일정 시간 대기 강제 */
  penalize(ms: number): void {
    this.penaltyUntil = Math.max(this.penaltyUntil, Date.now() + ms);
  }
  async take(): Promise<void> {
    const interval = 1000 / Math.max(0.1, this.rps);
    const now = Date.now();
    const at = Math.max(now, this.nextAt, this.penaltyUntil);
    this.nextAt = at + interval;
    if (at > now) await sleep(at - now);
  }
}

/** 텍스트를 바이트가 아닌 글자 수 기준으로 자르기 */
export function truncate(s: string, max: number): string {
  return [...s].length <= max ? s : [...s].slice(0, max).join('');
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
