import type { AppContext } from '../../context.js';
import { addDays, kstDate, kstWeekday } from '../../lib/util.js';
import { ACTION_STATUSES, EXCEPTION_STATUSES, STATUS_LABEL, type OrderStatus } from '../orders/stateMachine.js';

export interface DashboardSummary {
  today: { orders: number; sales: number; expectedProfit: number };
  yesterday: { orders: number; sales: number; expectedProfit: number };
  month: { orders: number; sales: number; expectedProfit: number; settledProfit: number };
  actionCount: number;
  exceptionCount: number;
  byStatus: Record<string, number>;
  listings: Record<string, number>;
  candidatesNew: number;
  inquiriesOpen: number;
  lastOrderPollAt: string | null;
  publicIp: string | null;
  keyExpiresInDays: number | null;
  killSwitch: boolean;
  dryRun: boolean;
  live: Record<string, boolean>;
}

async function salesBetween(ctx: AppContext, from: Date, to: Date) {
  const r = await ctx.db
    .selectFrom('orders')
    .select((eb) => [
      eb.fn.countAll<number>().as('n'),
      eb.fn.coalesce(eb.fn.sum<number>('sale_amount'), eb.lit(0)).as('sales'),
      eb.fn.coalesce(eb.fn.sum<number>('expected_profit'), eb.lit(0)).as('profit'),
      eb.fn.coalesce(eb.fn.sum<number>('profit'), eb.lit(0)).as('settled'),
    ])
    .where('ordered_at', '>=', from)
    .where('ordered_at', '<', to)
    .where('status', 'not in', ['CANCELLED'])
    .executeTakeFirst();
  return { orders: Number(r?.n ?? 0), sales: Number(r?.sales ?? 0), expectedProfit: Number(r?.profit ?? 0), settledProfit: Number(r?.settled ?? 0) };
}

export async function keyExpiresInDays(ctx: AppContext): Promise<number | null> {
  const s = await ctx.settings.get();
  if (!s.coupang.keyIssuedAt) return null;
  const issued = new Date(`${s.coupang.keyIssuedAt}T00:00:00Z`);
  if (Number.isNaN(issued.getTime())) return null;
  // KST 달력 기준 일수 차이(만료일 − 오늘)
  const today = new Date(`${kstDate(ctx.clock.now())}T00:00:00Z`);
  return Math.round((issued.getTime() + s.coupang.keyValidDays * 86400_000 - today.getTime()) / 86400_000);
}

export async function dashboard(ctx: AppContext): Promise<DashboardSummary> {
  const s = await ctx.settings.get();
  const now = ctx.clock.now();
  const todayStart = new Date(`${kstDate(now)}T00:00:00+09:00`);
  const yStart = addDays(todayStart, -1);
  const mStart = new Date(`${kstDate(now).slice(0, 7)}-01T00:00:00+09:00`);
  const statusRows = await ctx.db.selectFrom('orders').select(['status', (eb) => eb.fn.countAll<number>().as('n')]).groupBy('status').execute();
  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.n)]));
  const listingRows = await ctx.db.selectFrom('listings').select(['status', (eb) => eb.fn.countAll<number>().as('n')]).groupBy('status').execute();
  const cand = await ctx.db.selectFrom('candidates').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'new').where('passed', '=', true).executeTakeFirst();
  const inq = await ctx.db.selectFrom('inquiries').select((eb) => eb.fn.countAll<number>().as('n')).where('status', 'in', ['new', 'drafted']).executeTakeFirst();
  const today = await salesBetween(ctx, todayStart, addDays(todayStart, 1));
  const yesterday = await salesBetween(ctx, yStart, todayStart);
  const month = await salesBetween(ctx, mStart, addDays(todayStart, 1));
  return {
    today: { orders: today.orders, sales: today.sales, expectedProfit: today.expectedProfit },
    yesterday: { orders: yesterday.orders, sales: yesterday.sales, expectedProfit: yesterday.expectedProfit },
    month,
    actionCount: ACTION_STATUSES.reduce((a, st) => a + (byStatus[st] ?? 0), 0),
    exceptionCount: EXCEPTION_STATUSES.reduce((a, st) => a + (byStatus[st] ?? 0), 0),
    byStatus,
    listings: Object.fromEntries(listingRows.map((r) => [r.status, Number(r.n)])),
    candidatesNew: Number(cand?.n ?? 0),
    inquiriesOpen: Number(inq?.n ?? 0),
    lastOrderPollAt: (await ctx.kv.get<string>('orders.lastPollOkAt')) ?? null,
    publicIp: (await ctx.kv.get<string>('net.publicIp')) ?? null,
    keyExpiresInDays: await keyExpiresInDays(ctx),
    killSwitch: s.killSwitch,
    dryRun: ctx.env.DRY_RUN,
    live: {
      listing: !ctx.env.DRY_RUN && ctx.env.LIVE_LISTING,
      pricing: !ctx.env.DRY_RUN && (ctx.env.LIVE_PRICING || ctx.env.LIVE_LISTING),
      fulfillment: !ctx.env.DRY_RUN && ctx.env.LIVE_FULFILLMENT,
      ordering: !ctx.env.DRY_RUN && ctx.env.LIVE_ORDERING,
      cs: !ctx.env.DRY_RUN && ctx.env.LIVE_CS,
    },
  };
}

/**
 * 아침 브리핑(매일 dailyReportHour, 기본 오전 9시): 자동화가 정상인지 + 어제 실적 + 상품 운영 + 선정 + 할 일.
 * 같은 시점에 개선용 데이터(상품별 일일 스냅샷)를 쌓고 오래된 대용량 기록을 정리한다.
 */
export async function sendDailyReport(ctx: AppContext): Promise<string> {
  const s = await ctx.settings.get();
  const d = await dashboard(ctx);
  const now = ctx.clock.now();
  const todayStart = new Date(`${kstDate(now)}T00:00:00+09:00`);
  const yStart = addDays(todayStart, -1);
  const won = (n: number) => `${Math.round(n).toLocaleString()}원`;
  const L: string[] = [];

  // 1) 시스템 상태
  const { JOBS } = await import('../../jobs/scheduler.js');
  const bad: string[] = [];
  for (const j of JOBS) {
    if (j.name === 'report.daily') continue;
    const r = await ctx.db.selectFrom('job_runs').select(['ok', 'error', 'started_at']).where('job', '=', j.name).orderBy('started_at', 'desc').executeTakeFirst();
    if (r && r.ok === false) bad.push(`${j.label}: ${(r.error ?? '').slice(0, 60)}`);
  }
  const pollAgo = d.lastOrderPollAt ? Math.round((now.getTime() - new Date(d.lastOrderPollAt).getTime()) / 60000) : null;
  const pollOk = pollAgo !== null && pollAgo <= 30;
  L.push(bad.length || !pollOk ? '🚨 시스템: 확인 필요' : '✅ 시스템: 자동 작업 모두 정상');
  if (!pollOk) L.push(`  · 주문 수집 마지막 성공: ${pollAgo === null ? '없음' : `${pollAgo}분 전`}`);
  for (const b of bad.slice(0, 5)) L.push(`  · ❌ ${b}`);
  const liveOn = Object.entries(d.live).filter(([, v]) => v).map(([k]) => ({ listing: '등록', pricing: '가격', fulfillment: '송장', ordering: '발주', cs: '문의' })[k as 'listing']);
  L.push(`  · 운영 모드: ${d.dryRun ? '모의 실행(실제 반영 없음)' : `실제 운영 — 켜진 기능: ${liveOn.join('·') || '없음'}`}`);

  // 2) 실적
  L.push('', '📈 실적');
  L.push(`  · 어제: 주문 ${d.yesterday.orders}건 · 매출 ${won(d.yesterday.sales)} · 예상이익 ${won(d.yesterday.expectedProfit)}`);
  L.push(`  · 이번 달: 주문 ${d.month.orders}건 · 매출 ${won(d.month.sales)} · 예상이익 ${won(d.month.expectedProfit)} · 정산확정 ${won(d.month.settledProfit)}`);
  const { listingProfit } = await import('../finance/service.js');
  const lp = await listingProfit(ctx, 7);
  if (lp.length) L.push(`  · 7일 이익 TOP: ${lp.slice(0, 3).map((x) => `${x.title.slice(0, 14)} ${won(x.expectedProfit)}(${x.orders}건)`).join(' · ')}`);

  // 3) 상품 운영(등록·교체)
  const newListed = await ctx.db.selectFrom('listings').select(['title', 'sale_price', 'dry_run']).where('listed_at', '>=', yStart).where('listed_at', '<', todayStart).execute();
  const stopped = await ctx.db.selectFrom('listings').select(['title', 'status_reason']).where('status', '=', 'stopped').where('updated_at', '>=', yStart).where('updated_at', '<', todayStart).execute();
  const lowered = await ctx.db.selectFrom('listings').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'active').where('zero_sale_adjusted', '=', true).executeTakeFirst();
  L.push('', '🛍 상품');
  const dry = await ctx.db.selectFrom('listings').select((eb) => eb.fn.countAll<number>().as('n')).where('dry_run', '=', true).where('status', 'in', ['active', 'pending_approval', 'paused']).executeTakeFirst();
  L.push(`  · 판매중 ${d.listings.active ?? 0} · 심사중 ${d.listings.pending_approval ?? 0} · 일시중지 ${d.listings.paused ?? 0} · 상한 ${s.listing.maxActiveListings}${Number(dry?.n ?? 0) ? ` (이 중 모의 ${dry!.n}개 — 실제 쿠팡엔 없음)` : ''}`);
  if (newListed.length) L.push(`  · 어제 새로 등록 ${newListed.length}개${newListed.some((x) => x.dry_run) ? '(모의)' : ''}: ${newListed.slice(0, 3).map((x) => `${x.title.slice(0, 16)} ${won(x.sale_price)}`).join(' · ')}`);
  if (stopped.length) L.push(`  · 어제 판매종료(교체 대상) ${stopped.length}개: ${stopped.slice(0, 3).map((x) => x.title.slice(0, 16)).join(' · ')}`);
  if (Number(lowered?.n ?? 0)) L.push(`  · 판매 부진으로 하한가 시험 중 ${lowered!.n}개(${s.listing.stopAfterLowerDays}일 더 안 팔리면 교체)`);

  // 4) 상품 선정
  const runs = await ctx.db.selectFrom('selection_runs').selectAll().where('at', '>=', yStart).execute();
  if (runs.length) {
    const sum = (k: 'evaluated' | 'passed' | 'listed') => runs.reduce((a, r) => a + r[k], 0);
    L.push('', '🔎 상품 선정(어제)');
    L.push(`  · ${runs.length}회 실행 · 검토 ${sum('evaluated')} · 통과 ${sum('passed')} · 등록 ${sum('listed')}`);
  }
  const waiting = await ctx.db.selectFrom('candidates').innerJoin('source_products', 'source_products.id', 'candidates.source_product_id')
    .select(['source_products.title', 'candidates.signals', 'candidates.est_profit']).where('candidates.status', '=', 'new').where('passed', '=', true).orderBy('score', 'desc').limit(3).execute();
  if (waiting.length) {
    L.push('  · 다음 등록 후보:');
    for (const w of waiting) {
      const sig = (typeof w.signals === 'string' ? JSON.parse(w.signals) : w.signals) as { demand?: { sales: number; profit: number } } | null;
      L.push(`    - ${w.title.slice(0, 22)} (개당 ${won(w.est_profit ?? 0)}${sig?.demand ? `, 기대 월 ${won(sig.demand.profit)}` : ''})`);
    }
  }

  // 5) 할 일
  const todo: string[] = [];
  if (d.actionCount) todo.push(`공급처 구매/결제 ${d.actionCount}건`);
  if (d.exceptionCount) todo.push(`주문 예외 ${d.exceptionCount}건`);
  if (d.inquiriesOpen) todo.push(`고객문의 ${d.inquiriesOpen}건`);
  const c = s.coupang;
  const missing = (['vendorUserId', 'outboundShippingPlaceCode', 'returnCenterCode', 'companyContactNumber'] as const).filter((k) => !c[k]);
  if (missing.length) todo.push(`설정 > 쿠팡 정보 입력(${missing.join(', ')})`);
  if (!ctx.env.MEDIA_PUBLIC_BASE_URL && s.listing.convertImages) todo.push('이미지 공개 켜기: bash ~/dropship/bin/media-public.sh');
  // 시장가(경쟁가) 공급원이 없으면 가격 경쟁력 판단이 약함 → 11번가 키 권장
  const recentLowest = await ctx.db.selectFrom('market_signals').select('id').where('kind', 'in', ['market_lowest', 'coupang_lowest']).where('at', '>=', addDays(now, -7)).executeTakeFirst();
  // 매일 반복하면 피로 → 월요일에만
  if (!recentLowest && kstWeekday(now) === 1) todo.push('(권장) 11번가 키 입력 → 경쟁가 비교로 가격·선정 정확도 향상(ELEVENST_API_KEY)');
  if (ctx.env.DRY_RUN) todo.push('지금은 모의 실행 중 — 실전 전환: bash ~/dropship/bin/golive.sh');
  else if (d.live.listing && !(d.live.fulfillment && d.live.ordering)) todo.push('⚠️ 실등록은 켜졌지만 주문 자동 처리 일부가 꺼져 있음 — 주문은 직접 처리해야 함(bash ~/dropship/bin/golive.sh 로 모두 켜기)');
  if (d.keyExpiresInDays !== null && d.keyExpiresInDays <= 14) todo.push(`쿠팡 API 키 재발급(D-${d.keyExpiresInDays})`);
  if (d.keyExpiresInDays === null) todo.push('설정 > 쿠팡 API 키 발급일 입력(만료 알림용)');
  if (d.killSwitch) todo.push('🛑 긴급 정지 해제 여부 확인');
  L.push('', todo.length ? '📝 할 일' : '📝 할 일 없음');
  for (const t of todo) L.push(`  · ${t}`);

  const body = L.join('\n');
  await ctx.notifications.notify(bad.length || !pollOk ? 'warn' : 'info', `☀️ 아침 브리핑 ${kstDate(now).slice(5).replace('-', '/')}`, body, { path: '/' });
  await recordDailyMetrics(ctx, yStart, todayStart);
  await pruneOldData(ctx);
  return body;
}

/** 개선용: 상품별 어제 하루 스냅샷(가격·주문·매출·이익) — 하루 상품 수만큼의 작은 행 */
export async function recordDailyMetrics(ctx: AppContext, from: Date, to: Date): Promise<number> {
  const day = kstDate(from);
  const rows = await ctx.db.selectFrom('listings').select(['id', 'status', 'sale_price', 'markup']).where('status', 'in', ['active', 'paused', 'pending_approval']).where('dry_run', '=', false).execute();
  for (const l of rows) {
    const o = await ctx.db.selectFrom('orders').select((eb) => [
      eb.fn.countAll<number>().as('n'),
      eb.fn.coalesce(eb.fn.sum<number>('sale_amount'), eb.lit(0)).as('rev'),
      eb.fn.coalesce(eb.fn.sum<number>('expected_profit'), eb.lit(0)).as('profit'),
    ]).where('listing_id', '=', l.id).where('ordered_at', '>=', from).where('ordered_at', '<', to).where('status', 'not in', ['CANCELLED']).executeTakeFirst();
    const v = { status: l.status, sale_price: l.sale_price, markup: l.markup, orders: Number(o?.n ?? 0), revenue: Number(o?.rev ?? 0), expected_profit: Number(o?.profit ?? 0) };
    await ctx.db.insertInto('daily_metrics').values({ day, listing_id: l.id, ...v }).onConflict((oc) => oc.columns(['day', 'listing_id']).doUpdateSet(v)).execute();
  }
  return rows.length;
}

/** 가볍게 유지: 탈락 후보(60일)·작업 기록(30일)·알림(90일)·시장 신호(400일)만 정리. 통과 후보·주문·스냅샷은 보관 */
export async function pruneOldData(ctx: AppContext): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.deleteFrom('candidates').where('passed', '=', false).where('created_at', '<', addDays(now, -60)).execute();
  await ctx.db.deleteFrom('job_runs').where('started_at', '<', addDays(now, -30)).execute();
  await ctx.db.deleteFrom('notifications').where('at', '<', addDays(now, -90)).execute();
  await ctx.db.deleteFrom('market_signals').where('at', '<', addDays(now, -400)).execute();
}

/** 감시: 주문 폴링 정지, 키 만료 임박, 공인 IP 변경 */
export async function watchdog(ctx: AppContext): Promise<{ alerts: number }> {
  const s = await ctx.settings.get();
  let alerts = 0;
  const last = await ctx.kv.get<string>('orders.lastPollOkAt');
  const startedAt = await ctx.kv.get<string>('app.startedAt');
  const now = ctx.clock.now();
  const staleMs = s.schedule.orderPollStaleMinutes * 60_000;
  const ref = last ?? startedAt;
  if (ref && now.getTime() - new Date(ref).getTime() > staleMs) {
    alerts++;
    await ctx.notifications.notify('error', '주문 수집이 멈췄습니다', `마지막 성공: ${last ?? '없음'}. 쿠팡 API 키/IP/네트워크를 확인하세요.`, { path: '/jobs', dedupeKey: 'watchdog-poll', dedupeMinutes: 60 });
  }
  const days = await keyExpiresInDays(ctx);
  if (days !== null && [14, 7, 3, 1, 0].includes(days)) {
    alerts++;
    await ctx.notifications.notify(days <= 3 ? 'error' : 'warn', `쿠팡 API 키 만료 D-${days}`, 'Wing > 판매자정보 > 추가판매정보 > OPEN API 키 재발급 후 서버 환경변수를 교체하세요.', { dedupeKey: `key-expiry-${days}`, dedupeMinutes: 24 * 60 });
  }
  alerts += await checkPublicIp(ctx);
  // 외부 생존 신호: 주문 수집이 정상일 때만 보냄(멈췄으면 외부 서비스가 알림)
  const pollOk = !ref || now.getTime() - new Date(ref).getTime() <= staleMs;
  if (ctx.env.HEARTBEAT_URL && pollOk) {
    try {
      await fetch(ctx.env.HEARTBEAT_URL, { signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      ctx.log.warn({ err: String(e) }, '하트비트 전송 실패');
    }
  }
  return { alerts };
}

/**
 * 공인 IP 변경 감지(집/사무실 PC 운영 대비). 쿠팡 OPEN API는 등록된 IP(최대 10개)에서만 호출 가능하므로
 * IP가 바뀌면 Wing에 새 IP를 등록해야 한다(반영 최대 30분, 공식 확인 2026-10-13).
 */
export async function checkPublicIp(ctx: AppContext): Promise<number> {
  if (!ctx.publicIp) return 0;
  let ip: string | null = null;
  try {
    ip = await ctx.publicIp();
  } catch {
    return 0;
  }
  if (!ip) return 0;
  const prev = await ctx.kv.get<string>('net.publicIp');
  if (prev === ip) return 0;
  await ctx.kv.set('net.publicIp', ip);
  await ctx.kv.set('net.publicIpChangedAt', ctx.clock.now().toISOString());
  if (!prev) {
    await ctx.notifications.notify('info', `서버 공인 IP: ${ip}`, '이 IP를 쿠팡 Wing > OPEN API 키 > 허용 IP에 등록하세요(최대 10개).', { dedupeKey: `ip-${ip}`, dedupeMinutes: 24 * 60 });
    return 0;
  }
  await ctx.notifications.notify('error', `공인 IP 변경: ${prev} → ${ip}`, '쿠팡 API 호출이 차단될 수 있습니다. Wing > 판매자정보 > 추가판매정보 > OPEN API 키에서 새 IP를 추가하세요(최대 30분 후 반영). 예전 IP는 그대로 두어도 됩니다(최대 10개).', { path: '/', dedupeKey: `ip-${ip}`, dedupeMinutes: 24 * 60 });
  return 1;
}
