import { CoupangClient } from '../adapters/coupang/client.js';
import { CoupangMarket } from '../adapters/coupang/market.js';
import { CoupangPartnersClient } from '../adapters/coupang/partners.js';
import { DomeggookSource } from '../adapters/domeggook/source.js';
import { GoogleTrendsClient } from '../adapters/google/trends.js';
import { NaverClient } from '../adapters/naver/client.js';
import { ElevenstSearchClient } from '../adapters/elevenst/search.js';
import { OwnerclanSource } from '../adapters/ownerclan/source.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { errMessage } from '../lib/util.js';

/**
 * 연결 점검: .env 의 키로 각 외부 서비스에 실제로 1회씩 조회해 결과를 보여준다(쓰기 없음, DB 미사용).
 *   bash ~/dropship/bin/check.sh
 */
type Result = { name: string; status: 'ok' | 'fail' | 'skip'; detail: string; hint?: string };

async function run(name: string, enabled: boolean, skipHint: string, fn: () => Promise<string>): Promise<Result> {
  if (!enabled) return { name, status: 'skip', detail: '설정 안 됨', hint: skipHint };
  try {
    return { name, status: 'ok', detail: await fn() };
  } catch (e) {
    return { name, status: 'fail', detail: errMessage(e).slice(0, 200) };
  }
}

export async function checkAll(env = loadEnv()): Promise<Result[]> {
  const log = createLogger('silent');
  const r: Result[] = [];

  r.push(await run('쿠팡 판매자 API', !!(env.COUPANG_VENDOR_ID && env.COUPANG_ACCESS_KEY && env.COUPANG_SECRET_KEY),
    'Wing에서 첫 상품 등록 후 OPEN API 키 발급 → COUPANG_* 입력', async () => {
      const m = new CoupangMarket(new CoupangClient({ baseUrl: env.COUPANG_BASE_URL, vendorId: env.COUPANG_VENDOR_ID!, accessKey: env.COUPANG_ACCESS_KEY!, secretKey: env.COUPANG_SECRET_KEY!, requestsPerSecond: 2, logger: log, retryBaseMs: 300 }), async () => '');
      const now = new Date();
      const lines = await m.listOrders(new Date(now.getTime() - 3600_000), now, 'ACCEPT');
      return `발주서 조회 성공(최근 1시간 결제완료 ${lines.length}건)${env.MARKET_ADAPTER !== 'coupang' ? ' — ⚠ MARKET_ADAPTER=coupang 으로 바꿔야 실제 연결됨' : ''}`;
    }));

  r.push(await run('오너클랜(자동 발주)', !!(env.OWNERCLAN_USERNAME && env.OWNERCLAN_PASSWORD), 'OWNERCLAN_USERNAME / OWNERCLAN_PASSWORD 입력', async () => {
    const oc = new OwnerclanSource({ username: env.OWNERCLAN_USERNAME!, password: env.OWNERCLAN_PASSWORD!, sandbox: env.OWNERCLAN_SANDBOX, logger: log });
    const items = await oc.search('수납', { limit: 3 });
    return `로그인·상품 검색 성공(예: ${items[0]?.title?.slice(0, 20) ?? '결과 없음'} ${items[0] ? `${items[0].price.toLocaleString()}원` : ''})`;
  }));

  // 판매 중 상품의 '주문 가능 점검'과 같은 호출(주문은 만들지 않는 시뮬레이션)
  r.push(await run('오너클랜 주문 가능 점검(시뮬레이션)', !!(env.OWNERCLAN_USERNAME && env.OWNERCLAN_PASSWORD), 'OWNERCLAN_USERNAME / OWNERCLAN_PASSWORD 입력', async () => {
    const oc = new OwnerclanSource({ username: env.OWNERCLAN_USERNAME!, password: env.OWNERCLAN_PASSWORD!, sandbox: env.OWNERCLAN_SANDBOX, logger: log });
    const items = await oc.search('수납', { limit: 5 });
    if (!items.length) return '검색 결과 0건이라 건너뜀';
    const d = await oc.getProduct(items[0]!.sourceItemId);
    if (!d) return '상품 상세 없음이라 건너뜀';
    const c = await oc.checkOrderable({ sourceItemId: d.sourceItemId, option: d.defaultOption, qty: 1, receiver: { name: '점검', phone: '010-0000-0000', addr1: '서울특별시 중구 세종대로 110', addr2: '', zip: '04524' } });
    if (!c.ok) throw new Error(`시뮬레이션 실패(${c.definitive ? '공급처 거부' : '일시 오류'}): ${c.reason}`);
    return `성공(주문 생성 없음): ${d.title.slice(0, 16)}${d.defaultOption ? ` [${d.defaultOption}]` : ''} 상품 ${c.cost.toLocaleString()}원 + 배송 ${c.shippingCost.toLocaleString()}원`;
  }));

  r.push(await run('도매꾹 Open API', !!env.DOMEGGOOK_API_KEY, 'openapi.domeggook.com 에서 Open API 키 발급', async () => {
    const dg = new DomeggookSource({ apiKey: env.DOMEGGOOK_API_KEY!, market: env.DOMEGGOOK_MARKET, logger: log });
    const items = await dg.search('수납', { limit: 3 });
    if (!items.length) return '응답은 정상이나 검색 결과 0건';
    const d = await dg.getProduct(items[0]!.sourceItemId);
    return `상품 목록·상세 조회 성공(예: ${items[0]!.title.slice(0, 20)} ${items[0]!.price.toLocaleString()}원, 이미지 재사용 ${d?.imageReuseAllowed ? '허용' : '불가'})`;
  }));

  const naver = new NaverClient({
    clientId: env.NAVER_CLIENT_ID, clientSecret: env.NAVER_CLIENT_SECRET, datalabEnabled: env.NAVER_DATALAB_ENABLED, logger: log,
    searchAd: env.NAVER_SEARCHAD_CUSTOMER_ID && env.NAVER_SEARCHAD_API_KEY && env.NAVER_SEARCHAD_SECRET
      ? { customerId: env.NAVER_SEARCHAD_CUSTOMER_ID, apiKey: env.NAVER_SEARCHAD_API_KEY, secret: env.NAVER_SEARCHAD_SECRET } : undefined,
  });
  r.push(await run('11번가 상품검색(시장가, 선택)', !!env.ELEVENST_API_KEY, '선택: openapi.11st.co.kr 키 → ELEVENST_API_KEY (네이버 쇼핑 API는 2026-07-31 종료)', async () => {
    const s = await new ElevenstSearchClient({ apiKey: env.ELEVENST_API_KEY!, logger: log }).shoppingSearch('캠핑의자');
    if (!s) throw new Error('응답 형식을 해석하지 못함');
    return `성공(상품 ${s.total.toLocaleString()}개, 상위 최저가 ${Math.min(...s.items.map((i) => i.price)).toLocaleString()}원)`;
  }));
  r.push(await run('네이버 검색광고 키워드도구', naver.hasSearchAd, '네이버 광고주센터(ads.naver.com) > API 관리 → NAVER_SEARCHAD_*', async () => {
    const rel = (await naver.relatedKeywords('캠핑의자')) ?? [];
    const top = [...rel].sort((a, b) => b.volume - a.volume).slice(0, 3).map((k) => `${k.keyword} ${k.volume.toLocaleString()}`).join(', ');
    return `성공(연관 키워드 ${rel.length}개: ${top})`;
  }));
  r.push(await run('네이버 데이터랩(선택)', env.NAVER_DATALAB_ENABLED && naver.hasOpenApi, '선택(앱에 권한 있을 때만 NAVER_DATALAB_ENABLED=true)', async () => {
    const t = await naver.weeklyTrend('캠핑의자', 12);
    return `성공(${t?.length ?? 0}주)`;
  }));
  r.push(await run('구글 트렌드(보조)', env.GOOGLE_TRENDS_ENABLED, 'GOOGLE_TRENDS_ENABLED=true 로 켜기', async () => {
    const g = await new GoogleTrendsClient({ logger: log }).weeklyTrend('캠핑의자');
    return g ? `성공(${g.length}주)` : '응답은 받았지만 데이터가 희소(이 키워드는 무시됨)';
  }));
  r.push(await run('쿠팡 파트너스(선택)', !!(env.COUPANG_PARTNERS_ACCESS_KEY && env.COUPANG_PARTNERS_SECRET_KEY), '선택: partners.coupang.com API 키 → COUPANG_PARTNERS_*', async () => {
    const v = await new CoupangPartnersClient({ accessKey: env.COUPANG_PARTNERS_ACCESS_KEY!, secretKey: env.COUPANG_PARTNERS_SECRET_KEY!, logger: log }).searchSignal('캠핑의자');
    if (!v) throw new Error('응답 없음(키·API 활성화 여부 확인)');
    return `성공(쿠팡 최저가 ${v.lowest.toLocaleString()}원, 로켓 ${Math.round(v.rocketRatio * 100)}%)`;
  }));
  r.push(await run('텔레그램 봇', !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), '@BotFather 봇 생성 → TELEGRAM_BOT_TOKEN/CHAT_ID', async () => {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const j: any = await res.json();
    if (!j.ok) throw new Error(j.description ?? '토큰 오류');
    return `성공(@${j.result.username})`;
  }));
  r.push(await run('Mac 꺼짐 감시(healthchecks)', !!env.HEARTBEAT_URL, 'healthchecks.io 체크 생성 → HEARTBEAT_URL', async () => {
    const res = await fetch(env.HEARTBEAT_URL!, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return '신호 전송 성공';
  }));
  return r;
}

async function main(): Promise<void> {
  const env = loadEnv();
  console.log(`모드: ${env.DRY_RUN ? '모의 실행(DRY_RUN)' : '실운영'} / 판매채널: ${env.MARKET_ADAPTER === 'coupang' ? '쿠팡 실서버' : '가짜 쿠팡(연습)'}\n`);
  const results = await checkAll(env);
  const icon = { ok: '✅', fail: '❌', skip: '⬜' } as const;
  for (const x of results) {
    console.log(`${icon[x.status]} ${x.name}: ${x.detail}${x.hint && x.status !== 'ok' ? `\n   → ${x.hint}` : ''}`);
  }
  const fails = results.filter((x) => x.status === 'fail').length;
  console.log(`\n정상 ${results.filter((x) => x.status === 'ok').length} · 실패 ${fails} · 미설정 ${results.filter((x) => x.status === 'skip').length}`);
  process.exit(fails ? 1 : 0);
}

if (process.argv[1]?.endsWith('check.js') || process.argv[1]?.endsWith('check.ts')) void main();
