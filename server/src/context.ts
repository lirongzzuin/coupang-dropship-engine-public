import type { SourceRegistry } from './adapters/registry.js';
import type { Env } from './config/env.js';
import { defaultSettings, diffSettings, dropStaleDefaults, mergeSettings, type Settings } from './config/settings.js';
import type { Database } from './db/index.js';
import type { PiiCipher } from './lib/crypto.js';
import type { Logger } from './lib/logger.js';
import type { Clock } from './lib/util.js';
import type { MarketPort } from './ports/market.js';
import type { MarketDataProvider, Notifier, ObjectStorage } from './ports/misc.js';

/** 사업 설정 저장소(DB) + 메모리 캐시 */
export class SettingsService {
  private cache?: Settings;
  constructor(private readonly db: Database) {}

  async get(): Promise<Settings> {
    if (this.cache) return this.cache;
    const row = await this.db.selectFrom('settings').select('value').where('key', '=', 'app').executeTakeFirst();
    if (!row) return (this.cache = defaultSettings());
    const stored = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    this.cache = mergeSettings(defaultSettings(), dropStaleDefaults(stored));
    // 예전 형식(전체 저장)이면 바꾼 값만 남기도록 정리
    const slim = diffSettings(this.cache, defaultSettings()) ?? {};
    if (JSON.stringify(slim) !== JSON.stringify(stored)) await this.save(slim);
    return this.cache;
  }

  async update(patch: unknown): Promise<Settings> {
    const next = mergeSettings(await this.get(), patch);
    await this.save(diffSettings(next, defaultSettings()) ?? {});
    this.cache = next;
    return next;
  }

  private async save(value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    await this.db
      .insertInto('settings')
      .values({ key: 'app', value: json, updated_at: new Date() })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: json, updated_at: new Date() }))
      .execute();
  }

  invalidate(): void {
    this.cache = undefined;
  }
}

/** 간단한 키-값 상태(폴링 커서 등) */
export class KvStore {
  constructor(private readonly db: Database) {}
  async get<T>(key: string): Promise<T | undefined> {
    const r = await this.db.selectFrom('kv').select('value').where('key', '=', key).executeTakeFirst();
    return r?.value as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    await this.db
      .insertInto('kv')
      .values({ key, value: JSON.stringify(value), updated_at: new Date() })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_at: new Date() }))
      .execute();
  }
}

/**
 * 알림: 모든 알림은 DB(관리 화면 대시보드)에 기록하고, "지금 사람이 확인해야 하는 것"만 텔레그램으로 보낸다.
 *
 * 텔레그램 전송 기준(push):
 *  - 보냄: 주문 처리 문제·구매/발주 필요, 고객 CS(문의·취소·반품·교환), 서버/연동 장애(주문 수집 중단·핵심 작업 실패·IP·API 키),
 *          안전장치(문제 감지·판매 중지)
 *  - 안 보냄: 상품 등록·선정·승인·반려·판매중지/재개·종료·원가 교체 등 자동 상품 운영, 설정 안내 → 관리 화면·아침 브리핑에서 확인
 * 기본값: level 'info' 는 안 보내고 warn/error/action 은 보냄. 호출부에서 opts.push 로 명시적으로 덮어쓴다.
 * 같은 dedupeKey는 일정 시간 내 1회만.
 * 방해금지 시간(설정 notify.quietHours, 한국시간)에는 급한 알림만 바로 보내고 나머지(텔레그램 대상만)는 보류 → 끝나면 flushHeld()가 모아서 한 번에
 */
const LEVEL_RANK: Record<string, number> = { info: 0, action: 1, warn: 2, error: 3 };
const LEVEL_ICON: Record<string, string> = { info: 'ℹ️', action: '👉', warn: '⚠️', error: '❗' };

export class NotificationService {
  private recent = new Map<string, number>();
  constructor(
    private readonly db: Database,
    private readonly notifier: Notifier,
    private readonly publicBase: string,
    private readonly clock: Clock,
    private readonly settings?: SettingsService,
  ) {}

  /** 지금이 방해금지 시간인지(한국시간) */
  async isQuiet(at: Date = this.clock.now()): Promise<boolean> {
    if (!this.settings) return false;
    const q = (await this.settings.get()).notify.quietHours;
    if (!q.enabled || q.start === q.end) return false;
    const h = (at.getUTCHours() + 9) % 24;
    return q.start > q.end ? h >= q.start || h < q.end : h >= q.start && h < q.end;
  }

  private async isUrgent(title: string, urgent?: boolean): Promise<boolean> {
    if (urgent) return true;
    if (!this.settings) return true;
    return (await this.settings.get()).notify.quietHours.urgentTitles.some((t) => t && title.startsWith(t));
  }

  async notify(level: 'info' | 'warn' | 'error' | 'action', title: string, body: string, opts: { path?: string; dedupeKey?: string; dedupeMinutes?: number; /** 방해금지 시간에도 바로 보냄 */ urgent?: boolean; /** 텔레그램 전송 여부(기본: info 외 전송) */ push?: boolean } = {}): Promise<void> {
    if (opts.dedupeKey) {
      const last = this.recent.get(opts.dedupeKey);
      const now = this.clock.now().getTime();
      if (last && now - last < (opts.dedupeMinutes ?? 60) * 60_000) return;
      this.recent.set(opts.dedupeKey, now);
    }
    const link = opts.path ? `${this.publicBase.replace(/\/$/, '')}${opts.path}` : undefined;
    const pushed = opts.push ?? level !== 'info';
    if (!pushed) {
      // 텔레그램 대상 아님 → 관리 화면에만 기록(밤사이 모음에도 넣지 않음)
      await this.db.insertInto('notifications').values({ level, title, body, link: link ?? null, pushed: false, delivered: false, at: this.clock.now() }).execute();
      return;
    }
    if ((await this.isQuiet()) && !(await this.isUrgent(title, opts.urgent))) {
      await this.db.insertInto('notifications').values({ level, title, body, link: link ?? null, delivered: false, held: true, at: this.clock.now() }).execute();
      return;
    }
    const delivered = await this.notifier.send({ level, title, body, link });
    await this.db.insertInto('notifications').values({ level, title, body, link: link ?? null, delivered, at: this.clock.now() }).execute();
  }

  /** 방해금지 시간이 끝나면 보류한 알림을 한 통으로 모아서 보냄(제목별 묶음·건수). 보낸 개수 반환 */
  async flushHeld(): Promise<number> {
    if (await this.isQuiet()) return 0;
    const rows = await this.db.selectFrom('notifications').selectAll().where('held', '=', true).orderBy('id').execute();
    if (!rows.length) return 0;
    const groups = new Map<string, { level: string; n: number; first: string; link: string | null }>();
    for (const r of rows) {
      const g = groups.get(r.title);
      const first = r.body.split('\n')[0]!.slice(0, 90);
      if (g) {
        g.n++;
        if (LEVEL_RANK[r.level]! > LEVEL_RANK[g.level]!) g.level = r.level;
      } else groups.set(r.title, { level: r.level, n: 1, first, link: r.link });
    }
    const top = rows.reduce<string>((a, r) => (LEVEL_RANK[r.level]! > LEVEL_RANK[a]! ? r.level : a), 'info') as 'info' | 'warn' | 'error' | 'action';
    const list = [...groups.entries()].sort((a, b) => LEVEL_RANK[b[1].level]! - LEVEL_RANK[a[1].level]!);
    const lines = list.slice(0, 25).map(([title, g]) => `${LEVEL_ICON[g.level] ?? '•'} ${title}${g.n > 1 ? ` ×${g.n}` : ''}${g.n === 1 && g.first ? ` — ${g.first}` : ''}`);
    if (list.length > 25) lines.push(`… 외 ${list.length - 25}종류`);
    const title = `🌙 밤사이 알림 ${rows.length}건`;
    const body = `${lines.join('\n')}\n\n자세한 내용은 관리 화면 홈의 알림에서 확인하세요.`;
    const link = `${this.publicBase.replace(/\/$/, '')}/`;
    const delivered = await this.notifier.send({ level: top, title, body, link });
    if (!delivered) return 0; // 전송 실패 → 보류 유지(다음 확인 때 다시)
    await this.db.updateTable('notifications').set({ held: false, delivered: true }).where('id', 'in', rows.map((r) => r.id)).execute();
    await this.db.insertInto('notifications').values({ level: top, title, body, link, delivered: true, at: this.clock.now() }).execute();
    return rows.length;
  }
}

export interface AppContext {
  env: Env;
  db: Database;
  log: Logger;
  clock: Clock;
  settings: SettingsService;
  kv: KvStore;
  /** 기본 판매채널(쿠팡) */
  market: MarketPort;
  /** 판매채널별(쿠팡·스마트스토어). 행의 market 값으로 고른다(marketFor). 없으면 쿠팡만 */
  markets?: Record<string, MarketPort>;
  /** 스마트스토어 전용 기능(카테고리 목록·이미지 업로드·주소록) — 키가 있을 때만 */
  naverApi?: import('./adapters/naver/commerce.js').NaverMarket;
  sources: SourceRegistry;
  marketData: MarketDataProvider;
  notifications: NotificationService;
  storage: ObjectStorage;
  pii: PiiCipher;
  /** 현재 공인 IP 조회(없으면 IP 감시 생략) */
  publicIp?: () => Promise<string | null>;
}

export async function audit(ctx: Pick<AppContext, 'db' | 'clock'>, actor: string, action: string, target?: string, detail?: unknown): Promise<void> {
  await ctx.db
    .insertInto('audit_log')
    .values({ actor, action, target: target ?? null, detail: detail === undefined ? null : JSON.stringify(detail), at: ctx.clock.now() })
    .execute();
}

/** 행(listings·orders)의 판매채널 → 그 채널 어댑터(없으면 기본 쿠팡) */
export function marketFor(ctx: Pick<AppContext, 'market' | 'markets'>, name: string | null | undefined): MarketPort {
  return (name && ctx.markets?.[name]) || ctx.market;
}

/** 쓸 수 있는 판매채널 목록(쿠팡 + 연결된 채널) */
export function allMarkets(ctx: Pick<AppContext, 'market' | 'markets'>): MarketPort[] {
  const list = [ctx.market];
  for (const [name, m] of Object.entries(ctx.markets ?? {})) if (name !== ctx.market.name && !list.includes(m)) list.push(m);
  return list;
}

export const MARKET_LABEL: Record<string, string> = { coupang: '쿠팡', naver: '스마트스토어' };
