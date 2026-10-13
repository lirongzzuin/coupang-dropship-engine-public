import type { SourceRegistry } from './adapters/registry.js';
import type { Env } from './config/env.js';
import { defaultSettings, mergeSettings, type Settings } from './config/settings.js';
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
    this.cache = row ? mergeSettings(defaultSettings(), row.value) : defaultSettings();
    return this.cache;
  }

  async update(patch: unknown): Promise<Settings> {
    const next = mergeSettings(await this.get(), patch);
    await this.db
      .insertInto('settings')
      .values({ key: 'app', value: JSON.stringify(next), updated_at: new Date() })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(next), updated_at: new Date() }))
      .execute();
    this.cache = next;
    return next;
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

/** 알림: DB에 항상 기록하고 외부 채널(텔레그램)로 전송. 같은 dedupeKey는 일정 시간 내 1회만 */
export class NotificationService {
  private recent = new Map<string, number>();
  constructor(
    private readonly db: Database,
    private readonly notifier: Notifier,
    private readonly publicBase: string,
    private readonly clock: Clock,
  ) {}

  async notify(level: 'info' | 'warn' | 'error' | 'action', title: string, body: string, opts: { path?: string; dedupeKey?: string; dedupeMinutes?: number } = {}): Promise<void> {
    if (opts.dedupeKey) {
      const last = this.recent.get(opts.dedupeKey);
      const now = this.clock.now().getTime();
      if (last && now - last < (opts.dedupeMinutes ?? 60) * 60_000) return;
      this.recent.set(opts.dedupeKey, now);
    }
    const link = opts.path ? `${this.publicBase.replace(/\/$/, '')}${opts.path}` : undefined;
    const delivered = await this.notifier.send({ level, title, body, link });
    await this.db.insertInto('notifications').values({ level, title, body, link: link ?? null, delivered, at: this.clock.now() }).execute();
  }
}

export interface AppContext {
  env: Env;
  db: Database;
  log: Logger;
  clock: Clock;
  settings: SettingsService;
  kv: KvStore;
  market: MarketPort;
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
