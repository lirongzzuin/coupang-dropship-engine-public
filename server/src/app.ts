import { join } from 'node:path';
import { CoupangClient } from './adapters/coupang/client.js';
import { CoupangMarket } from './adapters/coupang/market.js';
import { CoupangPartnersClient } from './adapters/coupang/partners.js';
import { GoogleTrendsClient } from './adapters/google/trends.js';
import { CompositeMarketData } from './adapters/marketData.js';
import { DomeggookSource } from './adapters/domeggook/source.js';
import { DryRunMarket } from './adapters/dryRunMarket.js';
import { FakeMarket } from './adapters/fake/fakeMarket.js';
import { MockSource } from './adapters/fake/mockSource.js';
import { DemoMarketData, demoSources } from './adapters/fake/demo.js';
import { NaverClient } from './adapters/naver/client.js';
import { ElevenstSearchClient } from './adapters/elevenst/search.js';
import { OwnerclanSource } from './adapters/ownerclan/source.js';
import { SourceRegistry } from './adapters/registry.js';
import { LocalStorage } from './adapters/storage/localStorage.js';
import { TelegramNotifier } from './adapters/telegram/notifier.js';
import type { Env } from './config/env.js';
import { type AppContext, KvStore, NotificationService, SettingsService } from './context.js';
import { createDb, migrate } from './db/index.js';
import { PiiCipher } from './lib/crypto.js';
import { createLogger } from './lib/logger.js';
import { type Clock, kstDate, systemClock } from './lib/util.js';
import type { MarketPort } from './ports/market.js';
import type { MarketDataProvider, Notifier, ObjectStorage } from './ports/misc.js';

/**
 * Composition root: 어떤 어댑터를 쓸지는 여기서만 결정한다.
 * 테스트는 overrides 로 가짜 구현을 주입한다.
 */
export interface BuildOverrides {
  market?: MarketPort;
  sources?: SourceRegistry;
  marketData?: MarketDataProvider;
  notifier?: Notifier;
  clock?: Clock;
  /** true면 DryRunMarket 래퍼를 씌우지 않음(테스트에서 실제 동작 검증용) */
  rawMarket?: boolean;
  storage?: ObjectStorage;
  publicIp?: (() => Promise<string | null>) | null;
}

export async function buildContext(env: Env, o: BuildOverrides = {}): Promise<AppContext> {
  const log = createLogger(env.LOG_LEVEL);
  const db = createDb({ databaseUrl: env.DATABASE_URL, dataDir: env.DATA_DIR });
  await migrate(db);
  const clock = o.clock ?? systemClock;
  const settings = new SettingsService(db);
  const s = await settings.get();

  let inner: MarketPort;
  if (o.market) inner = o.market;
  else if (env.MARKET_ADAPTER === 'coupang') {
    const client = new CoupangClient({
      baseUrl: env.COUPANG_BASE_URL,
      vendorId: env.COUPANG_VENDOR_ID!,
      accessKey: env.COUPANG_ACCESS_KEY!,
      secretKey: env.COUPANG_SECRET_KEY!,
      requestsPerSecond: s.coupang.requestsPerSecond,
      logger: log,
    });
    inner = new CoupangMarket(client, async () => (await settings.get()).coupang.vendorUserId);
  } else {
    const fake = new FakeMarket();
    fake.autoApprove = env.DEMO_MODE;
    inner = fake;
  }
  const market = o.rawMarket ? inner : new DryRunMarket(inner, env, log);

  const naver = new NaverClient({
    clientId: env.NAVER_CLIENT_ID,
    clientSecret: env.NAVER_CLIENT_SECRET,
    searchAd: env.NAVER_SEARCHAD_CUSTOMER_ID && env.NAVER_SEARCHAD_API_KEY && env.NAVER_SEARCHAD_SECRET
      ? { customerId: env.NAVER_SEARCHAD_CUSTOMER_ID, apiKey: env.NAVER_SEARCHAD_API_KEY, secret: env.NAVER_SEARCHAD_SECRET }
      : undefined,
    datalabEnabled: env.NAVER_DATALAB_ENABLED,
    logger: log,
  });
  const kv = new KvStore(db);
  const marketData = new CompositeMarketData(
    naver,
    env.GOOGLE_TRENDS_ENABLED ? new GoogleTrendsClient({ logger: log, cache: kv, now: () => clock.now() }) : undefined,
    env.COUPANG_PARTNERS_ACCESS_KEY && env.COUPANG_PARTNERS_SECRET_KEY
      ? new CoupangPartnersClient({ accessKey: env.COUPANG_PARTNERS_ACCESS_KEY, secretKey: env.COUPANG_PARTNERS_SECRET_KEY, logger: log, cache: kv, now: () => clock.now() })
      : undefined,
    env.ELEVENST_API_KEY ? new ElevenstSearchClient({ apiKey: env.ELEVENST_API_KEY, logger: log, cache: kv, now: () => clock.now() }) : undefined,
  );

  const demo = env.DEMO_MODE && env.MARKET_ADAPTER === 'fake';
  let sources = o.sources;
  if (!sources) {
    sources = new SourceRegistry();
    // 체험 모드에서는 실제 공급처를 등록하지 않음(실수로 실주문 방지)
    if (!demo && env.OWNERCLAN_USERNAME && env.OWNERCLAN_PASSWORD) {
      sources.register(new OwnerclanSource({ username: env.OWNERCLAN_USERNAME, password: env.OWNERCLAN_PASSWORD, sandbox: env.OWNERCLAN_SANDBOX, logger: log }));
    }
    if (!demo && env.DOMEGGOOK_API_KEY) sources.register(new DomeggookSource({ apiKey: env.DOMEGGOOK_API_KEY, market: env.DOMEGGOOK_MARKET, logger: log }));
    if (env.ENABLE_MOCK_SOURCE) sources.register(new MockSource('mock'));
    if (demo) for (const d of demoSources()) sources.register(d);
  }

  const notifier = o.notifier ?? new TelegramNotifier({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, logger: log });
  const ctx: AppContext = {
    env,
    db,
    log,
    clock,
    settings,
    kv,
    market,
    sources,
    marketData: o.marketData ?? (demo ? new DemoMarketData() : marketData),
    notifications: new NotificationService(db, notifier, env.PUBLIC_BASE_URL, clock),
    storage: o.storage ?? new LocalStorage(join(env.DATA_DIR, 'media'), env.PUBLIC_BASE_URL),
    pii: new PiiCipher(env.PII_KEY),
    publicIp: o.publicIp === null ? undefined : (o.publicIp ?? (env.PUBLIC_IP_CHECK ? lookupPublicIp : undefined)),
  };
  await ctx.kv.set('app.startedAt', clock.now().toISOString());
  if (demo && !(await ctx.db.selectFrom('settings').select('key').where('key', '=', 'app').executeTakeFirst())) {
    await settings.update({
      selection: { sources: ['demo-auto', 'demo-manual'], seedKeywords: ['수납 정리함', '캠핑 의자'] },
      coupang: { vendorUserId: 'demo', outboundShippingPlaceCode: 'DEMO', returnCenterCode: 'DEMO', companyContactNumber: '1588-0000', returnChargeName: '데모', returnZipCode: '04524', returnAddress: '서울특별시 중구 세종대로 110', returnAddressDetail: '데모', keyIssuedAt: kstDate(clock.now()) },
    });
  }
  return ctx;
}

/** 공인 IP 조회(여러 서비스 중 먼저 응답한 값) */
async function lookupPublicIp(): Promise<string | null> {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const t = (await r.text()).trim();
      if (r.ok && /^[0-9a-fA-F:.]{7,45}$/.test(t)) return t;
    } catch { /* 다음 서비스 */ }
  }
  return null;
}
