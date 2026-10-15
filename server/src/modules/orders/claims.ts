import { isLive } from '../../config/env.js';
import { allMarkets, type AppContext, audit, MARKET_LABEL, marketFor } from '../../context.js';
import type { OrderClaimRow, OrderRow } from '../../db/schema.js';
import { addDays, errMessage } from '../../lib/util.js';
import type { ClaimStage, MarketClaim } from '../../ports/market.js';
import { channelEnabled, decryptReceiver, OrderError, resolveCourierCode, transition } from './service.js';
import { canTransition, type OrderStatus, STATUS_LABEL } from './stateMachine.js';

/**
 * 취소·반품·교환(클레임)을 쿠팡 접수 단위로 끝까지 처리한다.
 *
 * 취소(상품준비중 = 출고중지요청): 공급처 주문 취소 → 취소 확인되면 쿠팡 [출고중지완료](고객 환불) → 취소됨
 *   - 공급처가 이미 보냈으면 쿠팡 [이미출고](송장) → 고객이 반품으로 진행
 *   - 자동 취소가 안 되는 공급처(도매꾹 등)는 사람에게 [공급처 취소 완료]/[이미 발송됨] 버튼으로 넘김
 * 취소(결제완료 즉시취소): 쿠팡은 이미 환불 → 공급처 주문만 취소
 * 반품: 단계별 안내(공급처 반품 접수 → 회수·입고 → 승인/빠른환불) → 반품완료면 반품완료(손익은 정산 대사에서)
 * 교환: 안내 + [공급처 재발송] → 재발송 송장 안내 → 교환 완료 시 종료
 * 고객 철회: 클레임 전 상태로 복구(공급처 취소를 이미 요청했으면 사람 확인)
 */
const SYSTEM = 'system';
/** 판매채널 관리 화면 이름(쿠팡 Wing / 스마트스토어센터) */
const center = (market: string) => (market === 'naver' ? '스마트스토어센터' : 'Wing');
const CLOSED_STAGES: ClaimStage[] = ['return_done', 'exchange_done', 'withdrawn'];

/** 쿠팡 상태 → 진행 단계(어댑터가 stage 를 주지 않은 경우의 호환 처리) */
export function stageOf(c: MarketClaim): ClaimStage {
  if (c.stage) return c.stage;
  if (c.type === 'EXCHANGE') return c.status === 'SUCCESS' ? 'exchange_done' : c.status === 'REJECT' || c.status === 'CANCEL' ? 'withdrawn' : 'exchange_open';
  if (c.status === 'RU' || c.status === 'RELEASE_STOP_UNCHECKED') return 'stop_requested';
  if (c.type === 'CANCEL') return 'cancelled';
  if (c.status === 'CC' || c.status === 'RETURNS_COMPLETED') return 'return_done';
  if (c.status === 'PR' || c.status === 'REQUEST_COUPANG_CHECK') return 'coupang_check';
  if (c.status === 'VENDOR_WAREHOUSE_CONFIRM') return 'return_collected';
  return 'return_requested';
}

export const STAGE_LABEL: Record<string, string> = {
  cancelled: '취소 완료(쿠팡 환불)', stop_requested: '출고중지 요청(고객 취소)', return_requested: '반품 접수', return_collected: '반품 입고완료(승인 대기)',
  coupang_check: '쿠팡 확인 요청', return_done: '반품 완료', exchange_open: '교환 진행', exchange_done: '교환 완료', withdrawn: '철회·종료',
};

// ── 수집 ────────────────────────────────────────────────────────────

export async function pollClaims(ctx: AppContext): Promise<{ claims: number }> {
  const now = ctx.clock.now();
  const open = await ctx.db.selectFrom('order_claims').selectAll().where('closed_at', 'is', null).execute();
  // 열린 클레임은 상태 변화를 계속 봐야 하므로 가장 오래된 접수까지 조회(최대 30일)
  const oldest = Math.min(addDays(now, -3).getTime(), ...open.map((c) => new Date(c.requested_at).getTime() - 3600_000));
  const from = new Date(Math.max(oldest, addDays(now, -30).getTime()));
  let n = 0;
  const seen = new Set<number>();
  const polled = new Set<string>();
  for (const market of allMarkets(ctx)) {
    if (!(await channelEnabled(ctx, market.name))) continue;
    let claims: MarketClaim[];
    try {
      claims = await market.listClaims(from, now);
    } catch (e) {
      // 쿠팡 조회 실패는 기존처럼 작업 실패, 다른 채널 실패는 쿠팡 처리를 막지 않음
      if (market === ctx.market) throw e;
      ctx.log.error({ market: market.name, err: errMessage(e) }, '클레임 조회 실패');
      continue;
    }
    polled.add(market.name);
    for (const c of claims) {
      let q = ctx.db.selectFrom('orders').selectAll().where('market', '=', market.name).where('market_order_id', '=', c.marketOrderId);
      if (c.vendorItemId) q = q.where('vendor_item_id', '=', c.vendorItemId);
      for (const o of await q.execute()) {
        const row = await upsertClaim(ctx, o, c);
        seen.add(row.id);
        if (await handleClaimSafe(ctx, row.id)) n++;
      }
    }
  }
  // 목록에 안 보이는 열린 클레임: 단건 조회로 최신 상태(고객 철회 포함) 확인 후 진행
  for (const row of open) {
    if (seen.has(row.id)) continue;
    const market = marketFor(ctx, row.market);
    // 직접 만든 기록(seller-·reship-)은 조회 대상 아님. 쿠팡은 반품 접수만 단건 조회 가능, 스마트스토어는 상품주문 조회
    const lookup = !row.receipt_id.includes('-') && (row.claim_type === 'RETURN' || row.receipt_id.includes(':'));
    if (lookup && market.getClaim && polled.has(market.name)) {
      try {
        const c = await market.getClaim(row.receipt_id);
        if (c) await ctx.db.updateTable('order_claims').set({ stage: stageOf(c), raw_status: c.status, updated_at: now }).where('id', '=', row.id).execute();
      } catch (e) {
        ctx.log.warn({ claim: row.id, err: errMessage(e) }, '클레임 단건 조회 실패');
      }
    }
    if (await handleClaimSafe(ctx, row.id)) n++;
  }
  return { claims: n };
}

async function upsertClaim(ctx: AppContext, o: OrderRow, c: MarketClaim): Promise<OrderClaimRow> {
  const now = ctx.clock.now();
  const stage = stageOf(c);
  const existing = await ctx.db.selectFrom('order_claims').selectAll().where('market', '=', o.market).where('receipt_id', '=', c.receiptId).where('order_id', '=', o.id).executeTakeFirst();
  if (existing) {
    if (existing.stage === stage && existing.raw_status === c.status) return existing;
    return ctx.db.updateTable('order_claims').set({
      stage, raw_status: c.status, updated_at: now,
      // 다시 열린 클레임(예: 출고중지요청 → 이미출고 후 반품 진행)
      ...(existing.closed_at && !CLOSED_STAGES.includes(stage) && stage !== 'cancelled' ? { closed_at: null } : {}),
      ...(c.returnShippingCharge !== undefined ? { return_shipping_charge: c.returnShippingCharge } : {}),
      ...(c.faultBy ? { fault_by: c.faultBy } : {}),
      ...(c.pickupType !== undefined ? { pickup_type: c.pickupType } : {}),
    }).where('id', '=', existing.id).returningAll().executeTakeFirstOrThrow();
  }
  const row = await ctx.db.insertInto('order_claims').values({
    order_id: o.id, market: o.market, receipt_id: c.receiptId, claim_type: c.type, stage, raw_status: c.status,
    count: c.count ?? null, reason: c.reason ?? '', fault_by: c.faultBy ?? null, return_shipping_charge: c.returnShippingCharge ?? null,
    prev_status: o.status, pickup_type: c.pickupType ?? null, requested_at: c.requestedAt, created_at: now, updated_at: now,
  }).returningAll().executeTakeFirstOrThrow();
  await ctx.db.insertInto('order_events').values({ order_id: o.id, from_status: o.status, to_status: o.status, reason: `${c.type === 'EXCHANGE' ? '교환' : c.type === 'CANCEL' ? '취소' : '취소·반품'} 접수 ${c.receiptId}: ${STAGE_LABEL[stage]} — ${c.reason || '사유 없음'}`, actor: SYSTEM, at: now }).execute();
  return row;
}

async function handleClaimSafe(ctx: AppContext, claimId: number): Promise<boolean> {
  try {
    return await handleClaim(ctx, claimId);
  } catch (e) {
    ctx.log.error({ claim: claimId, err: errMessage(e) }, '클레임 처리 실패');
    return false;
  }
}

// ── 처리 ────────────────────────────────────────────────────────────

const getClaimRow = (ctx: AppContext, id: number) => ctx.db.selectFrom('order_claims').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const getOrderRow = (ctx: AppContext, id: number) => ctx.db.selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

async function patchClaim(ctx: AppContext, row: OrderClaimRow, patch: Partial<Record<keyof OrderClaimRow, unknown>>): Promise<OrderClaimRow> {
  return ctx.db.updateTable('order_claims').set({ ...patch, updated_at: ctx.clock.now() } as any).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
}

const close = (ctx: AppContext, row: OrderClaimRow, note?: string) => patchClaim(ctx, row, { closed_at: ctx.clock.now(), ...(note ? { action_note: note } : {}) });

/** 같은 단계·같은 내용 알림은 한 번만 */
async function notifyOnce(ctx: AppContext, row: OrderClaimRow, tag: string, level: 'info' | 'warn' | 'error' | 'action', title: string, body: string): Promise<OrderClaimRow> {
  if (row.notified_stage === tag) return row;
  await ctx.notifications.notify(level, title, body, { path: `/orders/${row.order_id}` });
  return patchClaim(ctx, row, { notified_stage: tag });
}

/** 가능한 경로로 주문 상태 이동(직접 전이가 안 되면 그대로 두고 false) */
async function moveTo(ctx: AppContext, o: OrderRow, to: OrderStatus, reason: string, actor = SYSTEM, patch: Record<string, unknown> = {}): Promise<OrderRow> {
  if (o.status === to) return o;
  if (canTransition(o.status as OrderStatus, to)) return transition(ctx, o, to, reason, actor, patch);
  // 반품 단계는 반품요청을 거쳐서
  if (to === 'RETURNED' && canTransition(o.status as OrderStatus, 'RETURN_REQUESTED')) {
    return transition(ctx, await transition(ctx, o, 'RETURN_REQUESTED', reason, actor), 'RETURNED', reason, actor, patch);
  }
  if (canTransition(o.status as OrderStatus, 'MANUAL_REVIEW') && canTransition('MANUAL_REVIEW', to)) {
    return transition(ctx, await transition(ctx, o, 'MANUAL_REVIEW', reason, actor), to, reason, actor, patch);
  }
  ctx.log.warn({ order: o.id, from: o.status, to }, '클레임 상태 전이 불가');
  return o;
}

type SourceInfo =
  | { kind: 'none' } // 공급처 주문 없음(구매 전·모의)
  | { kind: 'manual'; name: string } // 공급처 자동 취소·조회 불가 → 사람이 처리
  | { kind: 'api'; name: string; state: string; rawStatus: string; tracking: { courierName: string; trackingNo: string; courierCode?: string } | null };

async function sourceInfo(ctx: AppContext, o: OrderRow): Promise<SourceInfo> {
  if (!o.source_order_id || o.source_order_id.startsWith('DRY-')) return { kind: 'none' };
  const sp = o.source_product_id ? await ctx.db.selectFrom('source_products').select('source').where('id', '=', o.source_product_id).executeTakeFirst() : undefined;
  const src = sp ? ctx.sources.get(sp.source) : undefined;
  const name = src?.displayName ?? '공급처';
  if (!src?.getOrderInfo || !src.cancelOrder || !isLive(ctx.env, 'LIVE_ORDERING') || o.purchase_strategy === 'assisted') return { kind: 'manual', name };
  const info = await src.getOrderInfo(o.source_order_id);
  return { kind: 'api', name, state: info.state, rawStatus: info.rawStatus, tracking: info.tracking };
}

async function requestSourceCancel(ctx: AppContext, o: OrderRow, reason: string): Promise<{ ok: boolean; note: string }> {
  const sp = await ctx.db.selectFrom('source_products').select('source').where('id', '=', o.source_product_id!).executeTakeFirstOrThrow();
  const src = ctx.sources.require(sp.source);
  try {
    const r = await src.cancelOrder!(o.source_order_id!, `고객 취소: ${reason}`.slice(0, 100));
    await audit(ctx, SYSTEM, 'order.source_cancel', String(o.id), r);
    return { ok: r.ok, note: r.ok ? `${src.displayName} 주문 취소 요청됨(${r.status})` : `${src.displayName} 자동 취소 실패: ${r.message}` };
  } catch (e) {
    return { ok: false, note: `${src.displayName} 자동 취소 실패: ${errMessage(e)}` };
  }
}

export async function handleClaim(ctx: AppContext, claimId: number): Promise<boolean> {
  const row = await getClaimRow(ctx, claimId);
  if (row.closed_at) return false;
  const o = await getOrderRow(ctx, row.order_id);
  const s = await ctx.settings.get();
  if (s.killSwitch) return false;
  switch (row.stage as ClaimStage) {
    case 'cancelled':
      return handleCancel(ctx, row, o, true);
    case 'stop_requested':
      return handleCancel(ctx, row, o, false);
    case 'return_requested':
    case 'return_collected':
    case 'coupang_check':
      return handleReturnOpen(ctx, row, o);
    case 'return_done': {
      await moveTo(ctx, o, 'RETURNED', `반품 완료(쿠팡 ${row.receipt_id})`);
      await close(ctx, row);
      return true;
    }
    case 'exchange_open':
      return handleExchange(ctx, row, o);
    case 'exchange_done':
      await close(ctx, row, '교환 완료');
      return true;
    case 'withdrawn':
      return handleWithdrawn(ctx, row, o);
    default:
      return false;
  }
}

/**
 * 취소: coupangDone=true 면 쿠팡은 이미 취소·환불(결제완료 즉시취소 / 판매자 취소 / 출고중지 완료).
 * false 면 상품준비중 출고중지요청 → 공급처 취소 확인 후 출고중지완료, 이미 보냈으면 이미출고.
 */
async function handleCancel(ctx: AppContext, row: OrderClaimRow, o: OrderRow, coupangDone: boolean): Promise<boolean> {
  const s = await ctx.settings.get();
  if (o.status === 'CANCELLED' || o.status === 'RETURNED') {
    await close(ctx, row);
    return false;
  }
  const count = row.count ?? o.qty;
  if (count < o.qty) {
    // 부분 취소: 공급처 부분 취소·부분 출고중지는 사람이 판단
    await notifyOnce(ctx, row, 'partial', 'action', '부분 취소 요청', `${o.item_name}: 주문 ${o.qty}개 중 ${count}개 취소 요청.\n공급처 주문 수량을 조정(또는 취소 후 재주문)하고 ${center(o.market)} 반품/취소 관리에서 처리하세요.`);
    if (o.status !== 'MANUAL_REVIEW') await moveTo(ctx, o, 'MANUAL_REVIEW', `부분 취소 요청 ${count}/${o.qty}개`);
    return false;
  }
  // 이미 쿠팡에 송장을 올린 주문(보낸 뒤 취소 요청) → 이미출고 처리
  if (!coupangDone && o.tracking_no && o.courier_code) return shippedForClaim(ctx, row, o, o.courier_code, o.tracking_no, '이미 송장 등록됨');

  const src = await sourceInfo(ctx, o);
  if (src.kind === 'none') {
    const wasWaiting = o.status === 'AWAITING_PURCHASE';
    if (!coupangDone && !(await stopShipment(ctx, row, o, count))) return false;
    await moveTo(ctx, o, 'CANCELLED', `고객 취소${coupangDone ? '' : '(출고중지 완료)'}: ${row.reason}`);
    await close(ctx, row, coupangDone ? '쿠팡 취소 완료' : '출고중지완료 처리');
    if (!coupangDone && !wasWaiting) await ctx.notifications.notify('info', '고객 취소 자동 처리', `${o.item_name}: 공급처 주문 전이라 쿠팡 출고중지완료만 처리했습니다(고객 환불).`, { path: `/orders/${o.id}` });
    if (wasWaiting) await ctx.notifications.notify('warn', '구매 전 고객 취소', `${o.item_name}: 고객이 취소했습니다. 공급처에서 이미 구매했다면 그 주문도 취소하세요.`, { path: `/orders/${o.id}` });
    return true;
  }
  if (src.kind === 'manual') {
    if (o.status !== 'CANCEL_REQUESTED') o = await moveTo(ctx, o, 'CANCEL_REQUESTED', `고객 취소 요청: ${row.reason}`);
    await notifyOnce(ctx, row, `manual:${row.stage}`, 'action', '고객 취소 — 공급처 주문 취소 필요',
      `${o.item_name}: ${src.name} 주문 ${o.source_order_id}\n① ${src.name}에서 주문 취소\n② 관리 화면 주문 > [공급처 취소 완료]${coupangDone ? '' : '(쿠팡 출고중지 자동 처리)'}\n이미 발송됐으면 [이미 발송됨]에 송장을 입력하세요${coupangDone ? '(쿠팡은 이미 환불됨 → 공급처에 반품·수취거부 요청)' : '(고객은 반품으로 진행)'}.`);
    return false;
  }
  // 공급처 API(오너클랜)
  if (src.tracking?.trackingNo) {
    if (coupangDone) {
      // 쿠팡은 취소·환불했는데 공급처가 이미 보냄 → 공급처 반품/수취거부(사람)
      await moveTo(ctx, o, 'MANUAL_REVIEW', `쿠팡 취소 완료 후 공급처 발송됨(${src.tracking.trackingNo})`);
      await notifyOnce(ctx, row, 'shipped-after-cancel', 'error', '취소된 주문이 공급처에서 발송됨',
        `${o.item_name}: 쿠팡은 취소·환불됐지만 ${src.name}이 이미 보냈습니다(${src.tracking.courierName} ${src.tracking.trackingNo}).\n${src.name}에 반품(수취거부) 접수하세요.`);
      await close(ctx, row, '공급처 이미 발송 — 반품 접수 필요');
      return true;
    }
    const code = resolveCourierCode(s.orders.courierAliases, src.tracking.courierName, src.tracking.courierCode);
    if (!code) {
      await notifyOnce(ctx, row, 'shipped-nocode', 'action', '취소 요청 — 이미 발송됨(직접 처리)', `${o.item_name}: ${src.name}이 이미 보냈습니다(${src.tracking.courierName} ${src.tracking.trackingNo}). 택배사 코드를 몰라 자동 처리 못 함 → ${center(o.market)} 반품/취소 관리에서 [이미출고] 처리하세요.`);
      return false;
    }
    return shippedForClaim(ctx, row, o, code, src.tracking.trackingNo, `${src.name} 이미 발송`);
  }
  if (src.state === 'cancelled') {
    if (!coupangDone && !(await stopShipment(ctx, row, o, count))) return false;
    await moveTo(ctx, o, 'CANCELLED', `고객 취소: ${row.reason} — ${src.name} 취소 확인${coupangDone ? '' : ', 출고중지 완료'}`);
    await close(ctx, row, `${src.name} 취소 확인${coupangDone ? '' : ' → 출고중지완료'}`);
    await ctx.notifications.notify('info', '고객 취소 자동 처리', `${o.item_name}: ${src.name} 주문 ${o.source_order_id} 취소 확인${coupangDone ? '(쿠팡은 이미 환불)' : ' → 쿠팡 출고중지완료(고객 환불)'}. 공급처 결제금은 공급처 정책대로 환불됩니다.`, { path: `/orders/${o.id}` });
    return true;
  }
  if (!row.source_cancel_at) {
    if (o.status !== 'CANCEL_REQUESTED') o = await moveTo(ctx, o, 'CANCEL_REQUESTED', `고객 취소 요청: ${row.reason}`);
    const r = await requestSourceCancel(ctx, o, row.reason);
    row = await patchClaim(ctx, row, { source_cancel_at: r.ok ? ctx.clock.now() : null, action: r.ok ? 'source_cancel' : 'source_cancel_failed', action_note: r.note });
    if (!r.ok) {
      await notifyOnce(ctx, row, 'source-cancel-failed', 'error', '공급처 자동 취소 실패', `${o.item_name}: ${r.note}\n${src.name}에서 주문 ${o.source_order_id}을 직접 취소한 뒤 관리 화면 [공급처 취소 완료]를 누르세요.`);
      return false;
    }
    // 결제완료 단계면 즉시 취소됨 → 바로 마무리
    const after = await sourceInfo(ctx, o);
    if (after.kind === 'api' && after.state === 'cancelled') return handleCancel(ctx, row, o, coupangDone);
    await ctx.notifications.notify('info', '고객 취소 — 공급처 취소 요청함', `${o.item_name}: ${r.note}. 공급사가 수락하면 자동으로 ${coupangDone ? '취소 완료' : '쿠팡 출고중지 처리'}합니다.`, { path: `/orders/${o.id}` });
    return true;
  }
  // 공급사가 취소 요청을 거절(취소요청 → 다시 결제완료·준비중) → 사람이 판단(보내면 자동으로 이미출고 처리)
  if (src.state === 'ok') {
    await notifyOnce(ctx, row, 'cancel-rejected', 'error', '공급처가 취소를 거절했어요', `${o.item_name}: ${src.name} 주문 ${o.source_order_id}의 취소 요청이 받아들여지지 않았습니다(현재 ${src.rawStatus}).\n${src.name} 1:1 문의로 취소를 다시 요청하세요. 그대로 발송되면 자동으로 쿠팡 이미출고 처리되고 고객은 반품으로 진행합니다(왕복 배송비 판매자 부담일 수 있음).`);
    return false;
  }
  // 공급사 수락 대기
  const waited = (ctx.clock.now().getTime() - new Date(row.source_cancel_at).getTime()) / 3600_000;
  if (waited >= s.orders.claimWaitHours) {
    await notifyOnce(ctx, row, 'cancel-wait', 'warn', '공급처 취소 수락 지연', `${o.item_name}: ${src.name} 주문 ${o.source_order_id} 취소 요청 후 ${Math.floor(waited)}시간째 ${src.rawStatus} 상태입니다. ${src.name}에 확인하세요(보내면 자동으로 이미출고 처리).`);
  }
  return false;
}

async function stopShipment(ctx: AppContext, row: OrderClaimRow, o: OrderRow, count: number): Promise<boolean> {
  const market = marketFor(ctx, o.market);
  if (!market.stopShipment) return false;
  const r = await market.stopShipment(row.receipt_id, count);
  await audit(ctx, SYSTEM, 'claim.stop_shipment', String(o.id), { receiptId: row.receipt_id, ...r });
  if (r.ok) {
    await patchClaim(ctx, row, { action: 'stop_shipment', action_note: r.dryRun ? 'DRY_RUN 출고중지완료' : '출고중지완료 처리' });
    return true;
  }
  if (r.retryable) return false;
  if (o.status !== 'CANCEL_REQUESTED') await moveTo(ctx, o, 'CANCEL_REQUESTED', `출고중지 처리 실패: ${r.message}`);
  await notifyOnce(ctx, row, 'stop-failed', 'error', '출고중지 처리 실패', `${o.item_name}: ${r.message}\n${center(o.market)} 반품/취소 관리에서 [출고중지완료]를 직접 처리한 뒤 관리 화면 [공급처 취소 완료]를 누르세요.`);
  return false;
}

async function shippedForClaim(ctx: AppContext, row: OrderClaimRow, o: OrderRow, courierCode: string, trackingNo: string, why: string): Promise<boolean> {
  if (row.action === 'already_shipped') return false;
  const r = marketFor(ctx, o.market).markShippedForClaim ? await marketFor(ctx, o.market).markShippedForClaim!(row.receipt_id, courierCode, trackingNo) : { ok: false, retryable: false, message: '지원 안 함' };
  await audit(ctx, SYSTEM, 'claim.already_shipped', String(o.id), { receiptId: row.receipt_id, ...r });
  if (!r.ok) {
    if (r.retryable) return false;
    await notifyOnce(ctx, row, 'shipped-failed', 'error', '이미출고 처리 실패', `${o.item_name}: ${r.message}\n${center(o.market)} 반품/취소 관리에서 [이미출고]에 송장(${trackingNo})을 직접 입력하세요.`);
    return false;
  }
  await patchClaim(ctx, row, { action: 'already_shipped', action_note: `${why} → 이미출고 처리(${trackingNo})` });
  const patch = { courier_code: courierCode, tracking_no: trackingNo, tracking_uploaded_at: o.tracking_uploaded_at ?? ctx.clock.now() };
  if (!['TRACKING_UPLOADED', 'IN_TRANSIT', 'DELIVERED'].includes(o.status)) await moveTo(ctx, o, 'TRACKING_UPLOADED', `${why} — 이미출고 처리(고객은 반품으로 진행)`, SYSTEM, patch);
  await ctx.notifications.notify('warn', '취소 요청 — 이미 발송되어 이미출고 처리', `${o.item_name}: ${why}(${trackingNo}). 쿠팡에 이미출고로 알렸습니다. 고객이 반품(수취거부)으로 진행하며, 왕복 배송비는 판매자 부담일 수 있습니다.`, { path: `/orders/${o.id}` });
  return true;
}

async function handleReturnOpen(ctx: AppContext, row: OrderClaimRow, o: OrderRow): Promise<boolean> {
  let moved = false;
  if (o.status !== 'RETURN_REQUESTED' && !['CANCELLED', 'RETURNED'].includes(o.status)) {
    const before = o.status;
    o = await moveTo(ctx, o, 'RETURN_REQUESTED', `반품 요청: ${row.reason}`);
    moved = o.status !== before;
  }
  const fee = row.return_shipping_charge;
  const feeText = fee == null ? '' : fee > 0 ? ` · 반품배송비 판매자 부담 ${fee.toLocaleString()}원` : fee < 0 ? ` · 반품배송비 고객 부담 ${(-fee).toLocaleString()}원` : '';
  const fault = row.fault_by ? ` · 귀책 ${row.fault_by}` : '';
  const src = o.source_order_id ? `공급처 주문 ${o.source_order_id}` : '공급처 주문 없음';
  if (row.stage === 'return_requested') {
    // 수기관리: 쿠팡이 회수하지 않음 → 공급처 반품 접수(공급처가 회수) 또는 판매자가 회수 송장 등록
    const pickup = row.pickup_type === '수기관리'
      ? '\n※ 회수 방식 "수기관리" — 쿠팡이 회수하지 않습니다. 공급처 반품 접수 시 공급처 택배로 회수를 요청하고, 회수 송장은 Wing 반품관리에 입력하세요.'
      : row.pickup_type ? `\n회수 방식: ${row.pickup_type}` : '';
    await notifyOnce(ctx, row, 'return_requested', 'action', '반품 요청', `${o.item_name}: ${row.reason || '사유 없음'}${fault}${feeText}\n① 공급처에 반품 접수(${src}) — 회수 상품은 공급처로\n② 회수되면 쿠팡 빠른환불(10만원 미만)이 자동 환불하거나, 공급처 입고 확인 후 관리 화면 [반품 승인(환불)]${pickup}`);
  } else if (row.stage === 'return_collected') {
    await notifyOnce(ctx, row, 'return_collected', 'action', '반품 입고완료 — 승인하면 환불', `${o.item_name}: 쿠팡에 반품 입고완료로 표시됐습니다. 상품 상태를 확인했으면 관리 화면 주문 > [반품 승인(환불)]을 누르세요.`);
  } else {
    await notifyOnce(ctx, row, 'coupang_check', 'warn', '반품 — 쿠팡 확인 요청 중', `${o.item_name}: 쿠팡이 반품 건을 확인 중입니다(쿠팡확인요청). ${center(o.market)} 반품 관리에서 진행 상황을 확인하세요.`);
  }
  return moved;
}

async function handleExchange(ctx: AppContext, row: OrderClaimRow, o: OrderRow): Promise<boolean> {
  const s = await ctx.settings.get();
  let changed = false;
  if (row.claim_type === 'EXCHANGE') {
    row = await notifyOnce(ctx, row, 'exchange_open', 'action', '교환 요청', `${o.item_name}: ${row.reason || '사유 없음'}\n① 공급처에 교환 접수(공급처 주문 ${o.source_order_id ?? '-'}) 또는 관리 화면 [공급처 재발송](새로 주문)\n② 재발송 송장을 ${center(o.market)} 교환 관리에 입력\n③ 회수 상품은 공급처로 반품`);
  }
  // 재발송 주문의 송장 회신
  if (row.reship_source_order_id && !row.reship_tracking) {
    const sp = o.source_product_id ? await ctx.db.selectFrom('source_products').select('source').where('id', '=', o.source_product_id).executeTakeFirst() : undefined;
    const src = sp ? ctx.sources.get(sp.source) : undefined;
    const t = src?.getOrderInfo && !row.reship_source_order_id.startsWith('DRY-') ? (await src.getOrderInfo(row.reship_source_order_id)).tracking : null;
    if (t?.trackingNo) {
      const code = resolveCourierCode(s.orders.courierAliases, t.courierName, t.courierCode) ?? t.courierName;
      row = await patchClaim(ctx, row, { reship_tracking: `${t.courierName} ${t.trackingNo}`, action_note: `재발송 송장 ${t.courierName} ${t.trackingNo}` });
      await ctx.notifications.notify('action', row.claim_type === 'EXCHANGE' ? `교환 재발송 송장 — ${center(o.market)}에 입력` : '재발송 송장', `${o.item_name}: ${t.courierName}(${code}) ${t.trackingNo}${row.claim_type === 'EXCHANGE' ? `\n${center(o.market)} 교환 관리에서 교환상품 송장으로 입력하세요.` : '\n고객에게 새 송장을 안내하세요(쿠팡 고객문의 답변 등).'}`, { path: `/orders/${o.id}` });
      changed = true;
      if (row.claim_type === 'RESHIP') await close(ctx, row, `재발송 송장 ${t.courierName} ${t.trackingNo}`);
    }
  }
  return changed;
}

async function handleWithdrawn(ctx: AppContext, row: OrderClaimRow, o: OrderRow): Promise<boolean> {
  if (row.claim_type === 'EXCHANGE') {
    await close(ctx, row, '교환 철회·불가');
    return true;
  }
  const prev = (row.prev_status ?? '') as OrderStatus;
  if (['CANCEL_REQUESTED', 'RETURN_REQUESTED', 'MANUAL_REVIEW'].includes(o.status)) {
    if (row.source_cancel_at) {
      await moveTo(ctx, o, 'MANUAL_REVIEW', '고객이 취소를 철회했지만 공급처 주문은 이미 취소 요청함');
      await ctx.notifications.notify('error', '고객 취소 철회 — 공급처 확인 필요', `${o.item_name}: 고객이 취소를 철회했지만 공급처 주문(${o.source_order_id}) 취소를 이미 요청했습니다. 공급처 상태를 확인하고 필요하면 다시 주문하세요.`, { path: `/orders/${o.id}` });
    } else if (prev && canTransition(o.status as OrderStatus, prev)) {
      await transition(ctx, o, prev, `고객 ${row.claim_type === 'RETURN' && row.prev_status && ['DELIVERED', 'SETTLED', 'IN_TRANSIT', 'TRACKING_UPLOADED'].includes(row.prev_status) ? '반품' : '취소'} 철회`, SYSTEM);
    } else {
      await moveTo(ctx, o, 'MANUAL_REVIEW', `고객 철회(이전 상태 ${prev ? STATUS_LABEL[prev] : '-'}) — 확인 필요`);
    }
  }
  await close(ctx, row, '고객 철회');
  return true;
}

// ── 관리자 조치 ─────────────────────────────────────────────────────

export async function listOrderClaims(ctx: AppContext, orderId: number) {
  const rows = await ctx.db.selectFrom('order_claims').selectAll().where('order_id', '=', orderId).orderBy('id').execute();
  return rows.map((r) => ({ ...r, stageLabel: STAGE_LABEL[r.stage] ?? r.stage }));
}

/**
 * 사람이 하는 클레임 조치
 * - source_cancelled: 공급처에서 직접 취소함 → (출고중지요청이면) 쿠팡 출고중지완료 → 취소됨
 * - shipped: 이미 발송됨(송장) → 쿠팡 이미출고
 * - approve_return: 반품 입고 확인·승인(환불)
 * - close: 처리 끝(Wing에서 직접 처리함)
 */
export async function claimAction(ctx: AppContext, orderId: number, claimId: number, input: { action: 'source_cancelled' | 'shipped' | 'approve_return' | 'close'; courier?: string; trackingNo?: string }, actor: string) {
  const row = await getClaimRow(ctx, claimId);
  if (row.order_id !== orderId) throw new OrderError('주문과 클레임이 맞지 않습니다');
  if (row.closed_at && input.action !== 'close') throw new OrderError('이미 끝난 클레임입니다');
  const o = await getOrderRow(ctx, orderId);
  const s = await ctx.settings.get();
  await audit(ctx, actor, `claim.${input.action}`, String(orderId), { claimId, ...input });
  if (input.action === 'close') {
    await close(ctx, row, `${actor} 처리 완료 표시`);
    return { message: '처리 완료로 표시했습니다' };
  }
  if (input.action === 'source_cancelled') {
    if (!['stop_requested', 'cancelled'].includes(row.stage)) throw new OrderError('취소 요청 단계가 아닙니다');
    if (row.stage === 'stop_requested') {
      const r = marketFor(ctx, o.market).stopShipment ? await marketFor(ctx, o.market).stopShipment!(row.receipt_id, row.count ?? o.qty) : null;
      if (!r?.ok) throw new OrderError(`쿠팡 출고중지완료 실패: ${r?.message ?? '지원 안 함'} — ${center(o.market)}에서 직접 처리 후 [처리 완료]`);
    }
    await moveTo(ctx, o, 'CANCELLED', `공급처 취소 완료(${actor})`, actor);
    await close(ctx, row, `공급처 취소 완료(${actor})${row.stage === 'stop_requested' ? ' → 출고중지완료' : ''}`);
    return { message: row.stage === 'stop_requested' ? '쿠팡 출고중지완료 처리 → 취소됨' : '취소됨으로 정리했습니다' };
  }
  if (input.action === 'shipped') {
    if (row.stage !== 'stop_requested') throw new OrderError('출고중지 요청 단계가 아닙니다');
    const code = resolveCourierCode(s.orders.courierAliases, input.courier ?? '');
    const no = (input.trackingNo ?? '').replace(/[^0-9A-Za-z]/g, '');
    if (!code || !no) throw new OrderError('택배사·송장번호를 확인하세요');
    if (!(await shippedForClaim(ctx, row, o, code, no, `${actor} 입력: 이미 발송`))) throw new OrderError('쿠팡 이미출고 처리 실패 — 알림을 확인하세요');
    return { message: '쿠팡에 이미출고로 처리했습니다(고객은 반품으로 진행)' };
  }
  // approve_return
  if (!['return_requested', 'return_collected'].includes(row.stage)) throw new OrderError('반품 승인 단계가 아닙니다');
  const r = marketFor(ctx, o.market).confirmReturn ? await marketFor(ctx, o.market).confirmReturn!(row.receipt_id, row.count ?? o.qty) : null;
  if (!r?.ok) throw new OrderError(`반품 승인 실패: ${r?.message ?? '지원 안 함'}`);
  await patchClaim(ctx, row, { stage: 'return_done', action: 'approve_return', action_note: `${actor} 반품 승인(환불)` });
  await handleClaim(ctx, row.id);
  return { message: '반품 승인 → 환불 처리됐습니다' };
}

/**
 * 판매자 주문 취소(공급처 품절·주소 문제 등). 쿠팡은 판매자 점수(주문이행)가 떨어진다고 명시 → 사람이 누를 때만.
 * 결제완료는 즉시 취소, 상품준비중은 출고중지 처리됨. 공급처 주문이 있으면 클레임 흐름으로 공급처 취소까지 진행.
 */
export async function sellerCancel(ctx: AppContext, orderId: number, reason: 'stock' | 'address' | 'price', actor: string) {
  const o = await getOrderRow(ctx, orderId);
  if (['CANCELLED', 'RETURNED', 'SETTLED'].includes(o.status) || o.tracking_no) throw new OrderError(`취소할 수 없는 상태: ${STATUS_LABEL[o.status as OrderStatus]}`);
  const market = marketFor(ctx, o.market);
  if (!market.cancelOrder) throw new OrderError('이 판매채널은 판매자 취소를 지원하지 않습니다');
  const r = await market.cancelOrder({ marketOrderId: o.market_order_id, vendorItemId: o.vendor_item_id, qty: o.qty, reason, shipmentBoxId: o.shipment_box_id });
  await audit(ctx, actor, 'order.seller_cancel', String(o.id), { reason, ...r });
  if (!r.ok) throw new OrderError(`${MARKET_LABEL[o.market] ?? o.market} 주문 취소 실패: ${r.message}`);
  const now = ctx.clock.now();
  const row = await ctx.db.insertInto('order_claims').values({
    order_id: o.id, market: o.market, receipt_id: `seller-${o.id}`, claim_type: 'CANCEL', stage: 'cancelled', raw_status: 'SELLER_CANCEL',
    count: o.qty, reason: `판매자 취소(${{ stock: '재고 문제', address: '배송지 문제', price: '가격 오류' }[reason]})`, prev_status: o.status, action: 'seller_cancel',
    requested_at: now, created_at: now, updated_at: now,
  }).onConflict((oc) => oc.columns(['market', 'receipt_id', 'order_id']).doUpdateSet({ stage: 'cancelled', closed_at: null, updated_at: now })).returningAll().executeTakeFirstOrThrow();
  await handleClaim(ctx, row.id);
  const after = await getOrderRow(ctx, o.id);
  return { message: after.status === 'CANCELLED' ? '쿠팡 주문을 취소했습니다(고객 환불)' : `쿠팡 주문을 취소했습니다 — ${STATUS_LABEL[after.status as OrderStatus]}(공급처 취소 진행 중)` };
}

/**
 * 공급처 재발송(교환·분실·파손): 같은 상품을 고객 주소로 다시 주문. 비용은 주문의 추가 비용(손익 차감).
 * 열린 교환 접수가 있으면 거기에 연결하고, 없으면 재발송 기록을 만든다. 송장이 회신되면 알림.
 */
export async function reshipOrder(ctx: AppContext, orderId: number, actor: string) {
  const o = await getOrderRow(ctx, orderId);
  if (!o.source_product_id) throw new OrderError('공급처 상품이 연결되지 않은 주문입니다');
  if (!o.receiver_addr_enc) throw new OrderError('배송지 정보가 파기된 주문입니다');
  const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', o.source_product_id).executeTakeFirstOrThrow();
  const src = ctx.sources.require(sp.source);
  if (!src.placeOrder || !src.capabilities.apiOrder) throw new OrderError(`${src.displayName}은 자동 주문이 안 됩니다 — ${src.displayName}에서 직접 주문하세요`);
  const open = await ctx.db.selectFrom('order_claims').selectAll().where('order_id', '=', o.id).where('closed_at', 'is', null).where('claim_type', 'in', ['EXCHANGE', 'RESHIP']).orderBy('id', 'desc').executeTakeFirst();
  if (open?.reship_source_order_id) throw new OrderError(`이미 재발송 주문이 있습니다(${open.reship_source_order_id})`);
  const n = Number((await ctx.db.selectFrom('order_claims').select((eb) => eb.fn.countAll<number>().as('n')).where('order_id', '=', o.id).where('reship_source_order_id', 'is not', null).executeTakeFirst())?.n ?? 0) + 1;
  const { findByVendorItem } = await import('../listing/items.js');
  const found = await findByVendorItem(ctx, o.vendor_item_id);
  const units = o.qty * (found?.unitQty ?? 1);
  const r = decryptReceiver(ctx, o);
  const s = await ctx.settings.get();
  const now = ctx.clock.now();
  let res: { sourceOrderId: string; cost: number; shippingCost: number };
  if (!isLive(ctx.env, 'LIVE_ORDERING')) {
    res = { sourceOrderId: `DRY-re-${o.id}-${n}`, cost: o.purchase_cost ?? o.expected_cost ?? 0, shippingCost: o.purchase_shipping ?? 0 };
  } else {
    res = await src.placeOrder({
      idempotencyKey: `cp-${o.market_order_id}-${o.vendor_item_id}-re${n}`,
      sourceItemId: sp.source_item_id,
      option: found?.option ?? (sp.detail as { defaultOption?: string } | null)?.defaultOption,
      qty: units,
      receiver: { name: r.name, phone: r.phone, addr1: r.addr1, addr2: r.addr2, zip: r.zip },
      sender: { name: s.orders.senderName || r.name, phone: s.orders.senderPhone || s.coupang.companyContactNumber || r.phone },
      deliveryMessage: r.deliveryMessage,
    });
  }
  const cost = res.cost + res.shippingCost;
  await audit(ctx, actor, 'order.reship', String(o.id), { sourceOrderId: res.sourceOrderId, cost });
  if (open) {
    await ctx.db.updateTable('order_claims').set({ reship_source_order_id: res.sourceOrderId, reship_cost: cost, action: 'reship', action_note: `재발송 주문 ${res.sourceOrderId}`, updated_at: now }).where('id', '=', open.id).execute();
  } else {
    await ctx.db.insertInto('order_claims').values({
      order_id: o.id, market: o.market, receipt_id: `reship-${o.id}-${n}`, claim_type: 'RESHIP', stage: 'exchange_open', raw_status: 'RESHIP', count: o.qty,
      reason: `재발송(${actor})`, prev_status: o.status, action: 'reship', action_note: `재발송 주문 ${res.sourceOrderId}`,
      reship_source_order_id: res.sourceOrderId, reship_cost: cost, requested_at: now, created_at: now, updated_at: now,
    }).execute();
  }
  await ctx.db.updateTable('orders').set((eb) => ({ extra_cost: eb('extra_cost', '+', cost), updated_at: now })).where('id', '=', o.id).execute();
  await ctx.db.insertInto('order_events').values({ order_id: o.id, from_status: o.status, to_status: o.status, reason: `재발송 주문 ${res.sourceOrderId}(${cost.toLocaleString()}원)`, actor, at: now }).execute();
  return { message: `${src.displayName}에 재발송 주문했습니다(${res.sourceOrderId}, ${cost.toLocaleString()}원). 송장이 나오면 알려드립니다.` };
}
