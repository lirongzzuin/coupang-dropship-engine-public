import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeMarket } from '../src/adapters/fake/fakeMarket.js';
import { MockSource } from '../src/adapters/fake/mockSource.js';
import { SourceRegistry } from '../src/adapters/registry.js';
import { LocalStorage } from '../src/adapters/storage/localStorage.js';
import { buildContext } from '../src/app.js';
import { type Env, loadEnv } from '../src/config/env.js';
import type { AppContext } from '../src/context.js';
import { ManualClock } from '../src/lib/util.js';
import type { MarketDataProvider, MarketSearchResult, Notifier } from '../src/ports/misc.js';

export class CapturingNotifier implements Notifier {
  sent: Array<{ level: string; title: string; body: string; link?: string }> = [];
  async send(msg: { level: 'info' | 'warn' | 'error' | 'action'; title: string; body: string; link?: string }): Promise<boolean> {
    this.sent.push(msg);
    return true;
  }
  titles(): string[] {
    return this.sent.map((m) => m.title);
  }
}

export class FakeMarketData implements MarketDataProvider {
  lowest = new Map<string, number>();
  volume = new Map<string, number>();
  trend = new Map<string, number[]>();
  related = new Map<string, Array<{ keyword: string; volume: number; competition: string }>>();
  google = new Map<string, number[]>();
  coupang = new Map<string, { lowest: number; median: number; rocketRatio: number; count: number }>();
  /** 키워드도구 응답(힌트 → 해당 키워드·연관 키워드) */
  stats = new Map<string, Array<{ keyword: string; volume: number; competition: string }>>();
  statsCalls: string[][] = [];
  async keywordStats(hints: string[]) {
    this.statsCalls.push(hints);
    return hints.flatMap((h) => this.stats.get(h) ?? []);
  }
  async relatedKeywords(seed: string) {
    return this.related.get(seed) ?? null;
  }
  async googleTrend(keyword: string) {
    return this.google.get(keyword) ?? null;
  }
  async coupangSearch(keyword: string) {
    return this.coupang.get(keyword) ?? null;
  }
  async shoppingSearch(keyword: string): Promise<MarketSearchResult | null> {
    const p = this.lowest.get(keyword);
    if (p === undefined) return null;
    return { total: 1200, items: [{ title: keyword, price: p, mall: 'A', productId: 'n1', link: 'https://x' }, { title: keyword, price: p + 3000, mall: 'B', productId: 'n2', link: 'https://y' }] };
  }
  async monthlySearchVolume(keywords: string[]): Promise<Record<string, number> | null> {
    return Object.fromEntries(keywords.filter((k) => this.volume.has(k)).map((k) => [k, this.volume.get(k)!]));
  }
  async weeklyTrend(keyword: string): Promise<number[] | null> {
    return this.trend.get(keyword) ?? null;
  }
}

export interface TestHarness {
  ctx: AppContext;
  market: FakeMarket;
  apiSource: MockSource;
  manualSource: MockSource;
  marketData: FakeMarketData;
  notifier: CapturingNotifier;
  clock: ManualClock;
  close(): Promise<void>;
}

export const TEST_ENV_BASE: Record<string, string> = {
  NODE_ENV: 'test',
  PII_KEY: 'a'.repeat(64),
  SESSION_SECRET: 'test-session-secret-123',
  DATA_DIR: ':memory:',
  LOG_LEVEL: 'silent',
  SCHEDULER_ENABLED: 'false',
  PUBLIC_BASE_URL: 'http://localhost:8080',
};

/**
 * live=true  → DRY_RUN=false + 모든 LIVE 플래그 on, FakeMarket 직접 사용(실제 부작용 경로 검증)
 * live=false → 기본값(DRY_RUN=true), DryRunMarket 래퍼 사용
 */
export async function makeHarness(opts: { live?: boolean; env?: Record<string, string>; start?: Date; publicIp?: () => Promise<string | null> } = {}): Promise<TestHarness> {
  const live = opts.live ?? true;
  const env: Env = loadEnv({
    ...TEST_ENV_BASE,
    ...(live ? { DRY_RUN: 'false', LIVE_LISTING: 'true', LIVE_PRICING: 'true', LIVE_FULFILLMENT: 'true', LIVE_ORDERING: 'true', LIVE_CS: 'true' } : {}),
    ...opts.env,
  });
  const market = new FakeMarket();
  const apiSource = new MockSource('mockapi', { apiOrder: true });
  const manualSource = new MockSource('mockmanual', { apiOrder: false });
  const sources = new SourceRegistry().register(apiSource).register(manualSource);
  const marketData = new FakeMarketData();
  const notifier = new CapturingNotifier();
  const clock = new ManualClock(opts.start ?? new Date('2026-10-13T01:00:00Z')); // KST 10:00
  const storageDir = mkdtempSync(join(tmpdir(), 'cde-media-'));
  const ctx = await buildContext(env, {
    market,
    rawMarket: live,
    sources,
    marketData,
    notifier,
    clock,
    storage: new LocalStorage(storageDir, env.PUBLIC_BASE_URL),
    publicIp: opts.publicIp ?? null,
  });
  await ctx.settings.update({
    fees: { monthlyServiceFee: 0 },
    selection: { sources: ['mockapi', 'mockmanual'], minSupplyPrice: 5000, minStock: 1 },
  });
  return { ctx, market, apiSource, manualSource, marketData, notifier, clock, close: () => ctx.db.destroy() };
}

/** 소스 상품 + 활성 상품(쿠팡 승인 완료 상태)을 바로 만들어 주문 테스트에 사용 */
export async function seedActiveListing(h: TestHarness, opts: { source?: 'mockapi' | 'mockmanual'; itemId?: string; price?: number; salePrice?: number; stock?: number; markup?: number } = {}) {
  const src = opts.source === 'mockmanual' ? h.manualSource : h.apiSource;
  const itemId = opts.itemId ?? `I${Math.floor(Math.random() * 1e9)}`;
  const d = src.add({ sourceItemId: itemId, title: `수납 정리함 ${itemId}`, price: opts.price ?? 15000, stock: opts.stock ?? 50 });
  const { upsertSourceProduct } = await import('../src/modules/catalog.js');
  const sp = await upsertSourceProduct(h.ctx, src.id, d);
  const vendorItemId = `VI-${itemId}`;
  const listing = await h.ctx.db
    .insertInto('listings')
    .values({
      source_product_id: sp.id,
      market: 'coupang',
      title: d.title,
      search_tags: JSON.stringify([]),
      sale_price: opts.salePrice ?? 30000,
      floor_price: 22000,
      markup: opts.markup ?? 0,
      images: JSON.stringify(d.images),
      status: 'active',
      vendor_item_id: vendorItemId,
      seller_product_id: `SP-${itemId}`,
      created_at: h.clock.now(),
      updated_at: h.clock.now(),
      listed_at: h.clock.now(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  h.market.items.set(vendorItemId, { price: listing.sale_price, qty: 50, onSale: true });
  return { src, d, sp, listing, vendorItemId };
}

export async function orderByBox(h: TestHarness, shipmentBoxId: string) {
  return h.ctx.db.selectFrom('orders').selectAll().where('shipment_box_id', '=', shipmentBoxId).executeTakeFirstOrThrow();
}
