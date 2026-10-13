import type { AppContext } from '../../context.js';
import { addDays, kstDate } from '../../lib/util.js';
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
      pricing: !ctx.env.DRY_RUN && ctx.env.LIVE_PRICING,
      fulfillment: !ctx.env.DRY_RUN && ctx.env.LIVE_FULFILLMENT,
      ordering: !ctx.env.DRY_RUN && ctx.env.LIVE_ORDERING,
      cs: !ctx.env.DRY_RUN && ctx.env.LIVE_CS,
    },
  };
}

export async function sendDailyReport(ctx: AppContext): Promise<string> {
  const d = await dashboard(ctx);
  const won = (n: number) => `${Math.round(n).toLocaleString()}원`;
  const lines = [
    `어제: 주문 ${d.yesterday.orders}건 · 매출 ${won(d.yesterday.sales)} · 예상이익 ${won(d.yesterday.expectedProfit)}`,
    `이번 달: 주문 ${d.month.orders}건 · 매출 ${won(d.month.sales)} · 예상이익 ${won(d.month.expectedProfit)} · 정산확정 ${won(d.month.settledProfit)}`,
    `운영 상품: 판매중 ${d.listings.active ?? 0} · 심사중 ${d.listings.pending_approval ?? 0} · 일시중지 ${d.listings.paused ?? 0}`,
    `할 일: 구매/결제 ${d.actionCount}건 · 예외 ${d.exceptionCount}건 · 문의 ${d.inquiriesOpen}건`,
  ];
  const ex = Object.entries(d.byStatus).filter(([st, n]) => n > 0 && EXCEPTION_STATUSES.includes(st as OrderStatus));
  if (ex.length) lines.push(`예외 상세: ${ex.map(([st, n]) => `${STATUS_LABEL[st as OrderStatus]} ${n}`).join(', ')}`);
  if (d.keyExpiresInDays !== null) lines.push(`쿠팡 API 키 만료까지 ${d.keyExpiresInDays}일${d.keyExpiresInDays <= 14 ? ' ⚠️ 재발급 필요' : ''}`);
  if (d.killSwitch) lines.push('🛑 긴급 정지 상태입니다');
  if (d.dryRun) lines.push('ℹ️ 모의 실행(DRY_RUN) 모드');
  const body = lines.join('\n');
  await ctx.notifications.notify('info', '일일 리포트', body, { path: '/' });
  return body;
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
