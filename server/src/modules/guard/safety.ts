import { audit, type AppContext } from '../../context.js';
import { errMessage, kstDate } from '../../lib/util.js';
import { pauseListing, resumeListing } from '../listing/control.js';

/**
 * 자동 안전장치(구매자 보호).
 *
 * 문제를 감지하면 텔레그램으로 경고하고, graceHours 안에 해결되지 않으면 자동으로 "판매 중지"한다.
 *  - 판매 중지 = 쿠팡의 모든 판매 상품을 판매중지(새 주문 차단) + 자동 등록 중지 + 재개 금지
 *  - 이미 결제된 주문은 계속 처리한다(멈추면 그 구매자가 피해를 봄). 주문별 안전장치(품절·역마진·한도)는 그대로
 *  - 구조적 오류(짧은 시간에 예외 주문 다발)는 기다리지 않고 즉시 판매 중지
 * 해제: 관리 화면 [판매 재개] 또는 bash ~/dropship/bin/resume-sales.sh
 */

export const HALT_REASON = '판매 중지(안전장치)';

export interface Halt {
  reason: string;
  at: string;
  by: 'auto' | 'manual';
}

interface Issue {
  since: string;
  message: string;
  fix: string;
  remindedAt?: string;
}

/** 사람이 처리해야 하는데 오래 머물면 문제로 보는 주문 상태(취소·반품 요청은 정상 고객 흐름이라 제외) */
const STUCK = ['NEW', 'AWAITING_PURCHASE', 'PAYMENT_PENDING', 'OUT_OF_STOCK', 'MARGIN_NEGATIVE', 'LIMIT_EXCEEDED', 'SOURCE_ERROR', 'MANUAL_REVIEW', 'SHIPPING_DELAYED', 'ADDRESS_CHANGED'] as const;
/** 짧은 시간에 몰리면 구조적 오류로 보는 상태 */
const ALARM = ['OUT_OF_STOCK', 'MARGIN_NEGATIVE', 'SOURCE_ERROR', 'MANUAL_REVIEW'] as const;

export async function getHalt(ctx: AppContext): Promise<Halt | null> {
  return (await ctx.kv.get<Halt | null>('safety.halt')) ?? null;
}

/** 판매 중지: 쿠팡 판매 상품 전부 판매중지 + 이후 자동 재개·자동 등록 금지 */
export async function haltSales(ctx: AppContext, reason: string, by: Halt['by']): Promise<{ paused: number; failed: number }> {
  const existing = await getHalt(ctx);
  if (!existing) await ctx.kv.set('safety.halt', { reason, at: ctx.clock.now().toISOString(), by } satisfies Halt);
  let paused = 0, failed = 0;
  const rows = await ctx.db.selectFrom('listings').selectAll().where('status', '=', 'active').execute();
  for (const l of rows) {
    try {
      if (await pauseListing(ctx, l, HALT_REASON)) paused++;
      else failed++;
    } catch (e) {
      failed++;
      ctx.log.warn({ listing: l.id, err: errMessage(e) }, '판매 중지 실패');
    }
  }
  if (!existing) {
    await audit(ctx, by === 'auto' ? 'safety' : 'admin', 'safety.halt', undefined, { reason, paused, failed });
    await ctx.notifications.notify('error', by === 'auto' ? '🛑 자동 판매 중지' : '🛑 판매 중지',
      `사유: ${reason}\n쿠팡 판매 상품 ${paused}개를 판매중지했습니다(새 주문 차단).${failed ? `\n⚠️ ${failed}개는 판매중지 실패 — Wing에서 직접 중지하세요.` : ''}\n이미 결제된 주문은 계속 처리합니다.\n해결 후 재개: 관리 화면 [판매 재개] 또는 bash ~/dropship/bin/resume-sales.sh`,
      { path: '/' });
  }
  return { paused, failed };
}

/** 판매 재개: 안전장치로 멈춘 상품만 다시 판매. 남은 문제는 감지 시점을 지금으로 다시 잡아 유예를 새로 준다 */
export async function resumeSales(ctx: AppContext, actor: string): Promise<{ resumed: number }> {
  await ctx.kv.set('safety.halt', null);
  let resumed = 0;
  const rows = await ctx.db.selectFrom('listings').selectAll().where('status', '=', 'paused').where('status_reason', '=', HALT_REASON).execute();
  for (const l of rows) if (await resumeListing(ctx, l)) resumed++;
  const issues = (await ctx.kv.get<Record<string, Issue>>('safety.issues')) ?? {};
  const now = ctx.clock.now().toISOString();
  for (const k of Object.keys(issues)) issues[k] = { ...issues[k]!, since: now, remindedAt: now };
  await ctx.kv.set('safety.issues', issues);
  await audit(ctx, actor, 'safety.resume', undefined, { resumed });
  await ctx.notifications.notify('info', '판매 재개', `상품 ${resumed}개 판매를 재개했습니다.${Object.keys(issues).length ? `\n아직 남은 문제 ${Object.keys(issues).length}건 — 해결하지 않으면 다시 자동 중지됩니다.` : ''}`, { path: '/', push: Object.keys(issues).length > 0 });
  return { resumed };
}

/** 현재 문제 목록(키 → 설명). immediate=true 는 유예 없이 즉시 판매 중지 */
type Found = { key: string; message: string; fix: string; immediate?: boolean; /** 알림만(판매 중지 사유 아님) */ noHalt?: boolean };

async function detect(ctx: AppContext): Promise<Found[]> {
  const s = await ctx.settings.get();
  const g = s.safety;
  const now = ctx.clock.now();
  const out: Found[] = [];

  // 1) 처리되지 않고 오래 머문 주문(구매자가 기다리는 중)
  const stuck = await ctx.db.selectFrom('orders').select(['id', 'item_name', 'status', 'status_reason', 'updated_at'])
    .where('status', 'in', [...STUCK]).where('updated_at', '<', new Date(now.getTime() - g.stuckOrderHours * 3600_000)).execute();
  for (const o of stuck) {
    out.push({ key: `order-${o.id}`, message: `주문 #${o.id} ${o.item_name.slice(0, 30)} — '${o.status}' 상태로 ${g.stuckOrderHours}시간 넘게 처리 안 됨(${o.status_reason ?? ''})`.slice(0, 200),
      fix: `관리 화면 주문 #${o.id}에서 처리(구매 확인·강행·송장 입력) 또는 Wing에서 고객 취소 후 상태를 '취소됨'으로 변경` });
  }
  // 2) 출고 기한이 지났는데 송장이 없음
  const late = await ctx.db.selectFrom('orders').select(['id', 'item_name', 'ship_by']).where('status', 'in', ['PURCHASED', 'SHIPPING_DELAYED'])
    .where('ship_by', 'is not', null).where('ship_by', '<', kstDate(now)).execute();
  for (const o of late) {
    out.push({ key: `late-${o.id}`, message: `주문 #${o.id} ${o.item_name.slice(0, 30)} — 출고 기한(${o.ship_by}) 지남, 송장 없음`,
      fix: '공급처(오너클랜)에 출고 상황 확인 → 송장을 관리 화면 또는 Wing에 입력. 출고 불가면 고객에게 안내 후 취소' });
  }
  // 3) 짧은 시간에 예외 주문 다발 → 구조적 오류(즉시)
  const burst = await ctx.db.selectFrom('order_events').select('order_id').distinct()
    .where('to_status', 'in', [...ALARM]).where('at', '>=', new Date(now.getTime() - g.burstWindowHours * 3600_000)).execute();
  if (burst.length >= g.burstCount) {
    out.push({ key: 'burst', immediate: true, message: `최근 ${g.burstWindowHours}시간 동안 예외 주문 ${burst.length}건(품절·역마진·발주 오류) — 구조적 문제 의심`,
      fix: '관리 화면 주문 > 예외함에서 원인 확인(공급처 장애·가격 오류 등) 후 처리' });
  }
  // 4) 주문 수집 중단(새 주문을 못 보고 있음)
  const lastOk = await ctx.kv.get<string>('orders.lastPollOkAt');
  const started = await ctx.kv.get<string>('app.startedAt');
  const ref = lastOk ?? started;
  // 방금 재시작했으면(15분 이내) 첫 수집을 기다림 — 재부팅 직후 오경보 방지
  const justStarted = started && now.getTime() - new Date(started).getTime() < 15 * 60_000;
  if (ref && !justStarted && now.getTime() - new Date(ref).getTime() > g.pollDownHours * 3600_000) {
    out.push({ key: 'poll-down', message: `쿠팡 주문 수집이 ${g.pollDownHours}시간 넘게 실패(마지막 성공 ${lastOk ?? '없음'})`,
      fix: '쿠팡 API 키·허용 IP·인터넷 확인(bash ~/dropship/bin/check.sh). 그동안 Wing에서 주문을 직접 확인' });
  }
  // 5) 주문 처리·송장·재고 동기화·주문 가능 점검 작업이 연속 실패
  for (const job of ['orders.poll', 'orders.fulfillment', 'listings.sync', 'listings.monitor']) {
    const runs = await ctx.db.selectFrom('job_runs').select(['ok']).where('job', '=', job).where('finished_at', 'is not', null).orderBy('id', 'desc').limit(g.jobFailStreak).execute();
    if (runs.length >= g.jobFailStreak && runs.every((r) => r.ok === false)) {
      out.push({ key: `job-${job}`, message: `작업 '${job}' ${g.jobFailStreak}회 연속 실패`, fix: '관리 화면 > 작업에서 오류 메시지 확인(bash ~/dropship/bin/status.sh)' });
    }
  }
  // 6) 답변 안 한 고객 문의(12시간) — 판매 중지 사유는 아니고 계속 알림
  const unanswered = await ctx.db.selectFrom('inquiries').select(['id', 'kind', 'content']).where('status', 'in', ['new', 'drafted'])
    .where('asked_at', '<', new Date(now.getTime() - 12 * 3600_000)).execute();
  if (unanswered.length) {
    out.push({ key: 'inquiries', noHalt: true, message: `답변 안 한 고객 문의 ${unanswered.length}건(12시간 넘음)`,
      fix: '관리 화면 > 문의 또는 Wing(고객센터 문의 포함)에서 답변' });
  }
  return out;
}

/** 감시(watchdog 주기마다): 새 문제 경고 → 유예 후 자동 판매 중지, 해결되면 정리 */
export async function safetyCheck(ctx: AppContext): Promise<{ issues: number; halted: boolean; newIssues: number; resolved: number }> {
  const s = await ctx.settings.get();
  const g = s.safety;
  const now = ctx.clock.now();
  const found = await detect(ctx);
  const prev = (await ctx.kv.get<Record<string, Issue>>('safety.issues')) ?? {};
  const next: Record<string, Issue> = {};
  let newIssues = 0, resolved = 0;
  const halt = await getHalt(ctx);
  for (const f of found) {
    const p = prev[f.key];
    if (p) {
      next[f.key] = { ...p, message: f.message, fix: f.fix };
      continue;
    }
    newIssues++;
    next[f.key] = { since: now.toISOString(), message: f.message, fix: f.fix, remindedAt: now.toISOString() };
    const when = f.immediate || f.noHalt || !g.autoHalt ? '' : `\n⏰ ${g.graceHours}시간 안에 해결되지 않으면 자동으로 판매를 중지합니다(새 주문 차단).`;
    await ctx.notifications.notify('error', '⚠️ 문제 감지', `${f.message}\n해결 방법: ${f.fix}${halt ? '' : when}`, { path: '/' });
  }
  for (const k of Object.keys(prev)) if (!next[k]) {
    resolved++;
    await ctx.notifications.notify('info', '✅ 문제 해결됨', prev[k]!.message, { dedupeKey: `safety-resolved-${k}`, dedupeMinutes: 60, push: true }); // 받은 경고를 닫아주는 알림
  }
  await ctx.kv.set('safety.issues', next);

  let halted = !!halt;
  if (!halt && g.autoHalt) {
    const overdue = found.filter((f) => !f.noHalt).filter((f) => f.immediate || now.getTime() - new Date(next[f.key]!.since).getTime() >= g.graceHours * 3600_000);
    if (overdue.length) {
      await haltSales(ctx, overdue.map((f) => f.message).slice(0, 3).join(' / ') + (overdue.length > 3 ? ` 외 ${overdue.length - 3}건` : ''), 'auto');
      halted = true;
    }
  }
  // 해결 안 된 문제는 주기적으로 다시 알림(묻히지 않게)
  for (const [k, v] of Object.entries(next)) {
    if (now.getTime() - new Date(v.remindedAt ?? v.since).getTime() < g.remindHours * 3600_000) continue;
    next[k] = { ...v, remindedAt: now.toISOString() };
    await ctx.notifications.notify('warn', '⏰ 아직 해결 안 된 문제', `${v.message}\n해결 방법: ${v.fix}`, { path: '/' });
  }
  await ctx.kv.set('safety.issues', next);
  return { issues: Object.keys(next).length, halted, newIssues, resolved };
}

export async function safetyStatus(ctx: AppContext): Promise<{ halt: Halt | null; issues: Array<Issue & { key: string }> }> {
  const issues = (await ctx.kv.get<Record<string, Issue>>('safety.issues')) ?? {};
  return { halt: await getHalt(ctx), issues: Object.entries(issues).map(([key, v]) => ({ key, ...v })) };
}
