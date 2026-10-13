import { isLive } from '../../config/env.js';
import { type AppContext, audit } from '../../context.js';
import type { OrderRow } from '../../db/schema.js';
import { hashAddress } from '../../lib/crypto.js';
import { maskName } from '../../lib/logger.js';
import { addDays, errMessage, kstDate } from '../../lib/util.js';
import type { MarketOrderLine } from '../../ports/market.js';
import { upsertSourceProduct } from '../catalog.js';
import { pauseListing } from '../listing/control.js';
import { findByVendorItem } from '../listing/items.js';
import { computeProfit } from '../pricing/pricing.js';
import { canTransition, isPrePurchase, type OrderStatus, STATUS_LABEL } from './stateMachine.js';

const SYSTEM = 'system';
const MAX_SOURCE_RETRIES = 6;

export class OrderError extends Error {}

export async function transition(ctx: AppContext, order: OrderRow, to: OrderStatus, reason: string | null, actor: string, patch: Record<string, unknown> = {}): Promise<OrderRow> {
  const from = order.status as OrderStatus;
  if (!canTransition(from, to)) throw new OrderError(`허용되지 않은 상태 전이: ${from} → ${to}`);
  const now = ctx.clock.now();
  const updated = await ctx.db
    .updateTable('orders')
    .set({ ...patch, status: to, status_reason: reason, updated_at: now })
    .where('id', '=', order.id)
    .where('status', '=', from) // 동시 처리 방지(낙관적 잠금)
    .returningAll()
    .executeTakeFirst();
  if (!updated) throw new OrderError(`주문 ${order.id} 상태가 이미 변경됨`);
  if (from !== to || reason) {
    await ctx.db.insertInto('order_events').values({ order_id: order.id, from_status: from, to_status: to, reason, actor, at: now }).execute();
  }
  return updated;
}

async function getOrder(ctx: AppContext, id: number): Promise<OrderRow> {
  const o = await ctx.db.selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirst();
  if (!o) throw new OrderError(`주문 없음: ${id}`);
  return o;
}

function encReceiver(ctx: AppContext, l: MarketOrderLine) {
  return {
    receiver_name_enc: ctx.pii.encrypt(l.receiver.name),
    receiver_phone_enc: ctx.pii.encrypt(l.receiver.phone),
    receiver_addr_enc: ctx.pii.encrypt(`${l.receiver.addr1}\n${l.receiver.addr2}`),
    receiver_zip: l.receiver.zip || null,
    delivery_message_enc: ctx.pii.encrypt(l.deliveryMessage ?? ''),
    address_hash: hashAddress([l.receiver.name, l.receiver.phone, l.receiver.addr1, l.receiver.addr2, l.receiver.zip]),
  };
}

export function decryptReceiver(ctx: AppContext, o: OrderRow) {
  const [addr1 = '', addr2 = ''] = (ctx.pii.decrypt(o.receiver_addr_enc) ?? '').split('\n');
  return {
    name: ctx.pii.decrypt(o.receiver_name_enc) ?? '',
    phone: ctx.pii.decrypt(o.receiver_phone_enc) ?? '',
    addr1,
    addr2,
    zip: o.receiver_zip ?? '',
    deliveryMessage: ctx.pii.decrypt(o.delivery_message_enc) ?? '',
  };
}

// ── 1. 주문 감지 ─────────────────────────────────────────────────────

export async function pollNewOrders(ctx: AppContext): Promise<{ fetched: number; inserted: number }> {
  const s = await ctx.settings.get();
  const now = ctx.clock.now();
  const last = await ctx.kv.get<string>('orders.lastPollAt');
  const from = last ? new Date(new Date(last).getTime() - s.coupang.orderPollOverlapMinutes * 60_000) : addDays(now, -1);
  const lines = await ctx.market.listOrders(from, now, 'ACCEPT');
  let inserted = 0;
  for (const l of lines) {
    if (l.canceled) continue;
    const res = await ctx.db
      .insertInto('orders')
      .values({
        market: ctx.market.name,
        market_order_id: l.marketOrderId,
        shipment_box_id: l.shipmentBoxId,
        vendor_item_id: l.vendorItemId,
        item_name: l.itemName,
        qty: l.qty,
        sale_amount: l.paidAmount,
        status: 'NEW',
        ordered_at: l.orderedAt,
        ship_by: l.shipBy ?? null,
        market_status: l.status,
        ...encReceiver(ctx, l),
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.columns(['market', 'shipment_box_id', 'vendor_item_id']).doNothing())
      .returning(['id'])
      .executeTakeFirst();
    if (res) {
      inserted++;
      await ctx.db.insertInto('order_events').values({ order_id: res.id, from_status: null, to_status: 'NEW', reason: '주문 감지', actor: SYSTEM, at: now }).execute();
    }
  }
  await ctx.kv.set('orders.lastPollAt', now.toISOString());
  await ctx.kv.set('orders.lastPollOkAt', now.toISOString());
  return { fetched: lines.length, inserted };
}

// ── 2. 검증 → 발주 ──────────────────────────────────────────────────

async function todaysPurchasedCost(ctx: AppContext): Promise<number> {
  const start = new Date(`${kstDate(ctx.clock.now())}T00:00:00+09:00`);
  const r = await ctx.db
    .selectFrom('orders')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('purchase_cost'), eb.lit(0)).as('total'))
    .where('purchased_at', '>=', start)
    .executeTakeFirst();
  return Number(r?.total ?? 0);
}

async function sourceRetryCount(ctx: AppContext, orderId: number): Promise<number> {
  const r = await ctx.db.selectFrom('order_events').select((eb) => eb.fn.countAll<number>().as('n')).where('order_id', '=', orderId).where('to_status', '=', 'SOURCE_ERROR').executeTakeFirst();
  return Number(r?.n ?? 0);
}

/**
 * NEW(및 재시도 대상 SOURCE_ERROR) 주문을 검증하고 발주까지 진행.
 * override=true 는 관리자가 예외(한도·마진·재고)를 확인하고 강행할 때.
 */
export async function processOrder(ctx: AppContext, orderId: number, opts: { override?: boolean; actor?: string } = {}): Promise<OrderRow> {
  const actor = opts.actor ?? SYSTEM;
  let o = await getOrder(ctx, orderId);
  const s = await ctx.settings.get();
  if (s.killSwitch) return o;
  if (!isPrePurchase(o.status as OrderStatus) || o.status === 'AWAITING_PURCHASE' || o.status === 'PAYMENT_PENDING') {
    if (!(opts.override && o.status === 'AWAITING_PURCHASE')) return o;
  }

  // 매핑(묶음 옵션이면 실제 보낼 수량 = 주문수량 × 묶음수량)
  const found = await findByVendorItem(ctx, o.vendor_item_id);
  if (!found) return transition(ctx, o, 'MANUAL_REVIEW', '등록 상품과 매핑되지 않은 주문(vendorItemId)', actor);
  const listing = found.listing;
  const units = o.qty * found.unitQty;
  const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', listing.source_product_id).executeTakeFirstOrThrow();
  if (o.listing_id !== listing.id) {
    o = await ctx.db.updateTable('orders').set({ listing_id: listing.id, source_product_id: sp.id }).where('id', '=', o.id).returningAll().executeTakeFirstOrThrow();
  }
  const source = ctx.sources.get(sp.source);
  if (!source) return transition(ctx, o, 'MANUAL_REVIEW', `공급처 어댑터 없음: ${sp.source}`, actor);

  // 실시간 재고·가격 재확인
  let price = sp.price;
  let shipping = sp.shipping_fee;
  if (source.capabilities.detail) {
    try {
      const d = await source.getProduct(sp.source_item_id, { title: sp.title });
      if (!d || d.status !== 'active' || (d.stock !== null && d.stock < units)) {
        if (d) await upsertSourceProduct(ctx, sp.source, d);
        await pauseListing(ctx, listing, '공급처 품절');
        if (!opts.override) {
          await ctx.notifications.notify('error', '품절 주문 발생', `${o.item_name} — 공급처 품절. 상품 판매중지함. 고객 취소 여부를 확인하세요.`, { path: `/orders/${o.id}` });
          return transition(ctx, o, 'OUT_OF_STOCK', '공급처 품절/재고 부족', actor);
        }
      } else {
        await upsertSourceProduct(ctx, sp.source, d);
        price = d.price;
        shipping = d.shippingFee;
      }
    } catch (e) {
      const n = await sourceRetryCount(ctx, o.id);
      if (n + 1 >= MAX_SOURCE_RETRIES) await ctx.notifications.notify('error', '공급처 조회 반복 실패', `${o.item_name}: ${errMessage(e)}`, { path: `/orders/${o.id}` });
      return transition(ctx, o, 'SOURCE_ERROR', `공급처 조회 실패: ${errMessage(e)}`, actor);
    }
  }

  const cost = price * units;
  const perUnitShipping = (sp.detail as { shippingPerUnit?: boolean } | null)?.shippingPerUnit;
  if (perUnitShipping) shipping *= units;
  const breakdown = computeProfit(s, o.sale_amount, { cost, shipping, categoryPath: sp.category_path, inputVatDeductible: sp.tax_invoice, feeRate: listing.fee_rate_actual });
  o = await ctx.db.updateTable('orders').set({ expected_cost: cost + shipping, expected_profit: breakdown.profit }).where('id', '=', o.id).returningAll().executeTakeFirstOrThrow();

  if (!opts.override) {
    if (breakdown.profit < 0) {
      await pauseListing(ctx, listing, '마진 역전');
      await ctx.notifications.notify('error', '마진 역전 주문', `${o.item_name}: 예상 손익 ${breakdown.profit.toLocaleString()}원. 상품 판매중지함.`, { path: `/orders/${o.id}` });
      return transition(ctx, o, 'MARGIN_NEGATIVE', `예상 손익 ${breakdown.profit}원`, actor);
    }
    const today = await todaysPurchasedCost(ctx);
    if (cost + shipping > s.orders.perOrderMaxCost || today + cost + shipping > s.orders.dailyMaxCost) {
      await ctx.notifications.notify('warn', '발주 한도 초과', `${o.item_name}: 건 ${(cost + shipping).toLocaleString()}원 / 오늘 누적 ${today.toLocaleString()}원. 승인하면 진행됩니다.`, { path: `/orders/${o.id}` });
      return transition(ctx, o, 'LIMIT_EXCEEDED', '건별/일별 발주 한도 초과', actor);
    }
  }

  // 상품준비중 처리 → 고객 즉시취소 방지. 이후 배송지 재확인(결제완료 단계에서 변경 가능)
  if (!o.acked_at) {
    const ack = (await ctx.market.acknowledge([o.shipment_box_id]))[o.shipment_box_id];
    if (!ack?.ok) {
      if (ack?.retryable) return transition(ctx, o, 'SOURCE_ERROR', `상품준비중 처리 실패(재시도): ${ack?.message}`, actor);
      const lines = await ctx.market.getOrderLines(o.shipment_box_id).catch(() => []);
      if (lines.some((l) => l.vendorItemId === o.vendor_item_id && (l.canceled || l.status === 'CANCELED'))) return transition(ctx, o, 'CANCELLED', '고객 취소', actor);
      return transition(ctx, o, 'MANUAL_REVIEW', `상품준비중 처리 실패: ${ack?.message}`, actor);
    }
    const lines = await ctx.market.getOrderLines(o.shipment_box_id);
    const line = lines.find((l) => l.vendorItemId === o.vendor_item_id);
    const patch: Record<string, unknown> = { acked_at: ctx.clock.now(), market_status: line?.status ?? 'INSTRUCT' };
    if (line) Object.assign(patch, encReceiver(ctx, line));
    o = await ctx.db.updateTable('orders').set(patch).where('id', '=', o.id).returningAll().executeTakeFirstOrThrow();
  }

  // 발주 전략 선택
  const canApi = source.capabilities.apiOrder && typeof source.placeOrder === 'function';
  if (canApi && (s.orders.mode === 'auto' || opts.override)) return placeApiOrder(ctx, o, sp.source_item_id, actor, units);

  if (o.status !== 'AWAITING_PURCHASE') {
    o = await transition(ctx, o, 'AWAITING_PURCHASE', canApi ? '승인 모드: 구매 확인 필요' : '공급처 API 발주 불가 → 구매 대행 작업', actor, { purchase_strategy: 'assisted' });
    await ctx.notifications.notify('action', '구매할 주문이 있어요', `${o.item_name} — 공급처에서 ${units}개 구매 (${maskName(decryptReceiver(ctx, o).name)}) — 예상 이익 ${breakdown.profit.toLocaleString()}원`, { path: `/orders/${o.id}` });
  }
  return o;
}

async function placeApiOrder(ctx: AppContext, o: OrderRow, sourceItemId: string, actor: string, units: number): Promise<OrderRow> {
  const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', o.source_product_id!).executeTakeFirstOrThrow();
  const source = ctx.sources.require(sp.source);
  const key = `cp-${o.market_order_id}-${o.vendor_item_id}`;
  if (!isLive(ctx.env, 'LIVE_ORDERING')) {
    // 모의 발주: 외부 호출 없이 흐름만 진행
    ctx.log.info({ order: o.id, key }, '[DRY_RUN] 공급처 발주 생략');
    return transition(ctx, o, 'PURCHASED', 'DRY_RUN 모의 발주', actor, {
      purchase_strategy: 'api', source_order_id: `DRY-${key}`, purchase_cost: o.expected_cost, purchase_shipping: 0, purchased_at: ctx.clock.now(),
    });
  }
  const r = decryptReceiver(ctx, o);
  try {
    const res = await source.placeOrder!({
      idempotencyKey: key,
      sourceItemId,
      qty: units,
      receiver: { name: r.name, phone: r.phone, addr1: r.addr1, addr2: r.addr2, zip: r.zip },
      deliveryMessage: r.deliveryMessage,
    });
    await audit(ctx, actor, 'order.placed', String(o.id), { source: sp.source, sourceOrderId: res.sourceOrderId, cost: res.cost });
    const patch = { purchase_strategy: 'api', source_order_id: res.sourceOrderId, purchase_cost: res.cost, purchase_shipping: res.shippingCost };
    if (res.needsPayment) {
      await ctx.notifications.notify('action', '공급처 결제가 필요해요', `${o.item_name}: ${source.displayName} 주문 ${res.sourceOrderId} 생성됨. 예치금 결제 후 [결제완료]를 눌러주세요.`, { path: `/orders/${o.id}` });
      return transition(ctx, o, 'PAYMENT_PENDING', '공급처 주문 생성, 결제 필요', actor, patch);
    }
    return transition(ctx, o, 'PURCHASED', `API 발주 완료(${source.displayName})`, actor, { ...patch, purchased_at: ctx.clock.now() });
  } catch (e) {
    const n = await sourceRetryCount(ctx, o.id);
    if (n + 1 >= MAX_SOURCE_RETRIES) await ctx.notifications.notify('error', '자동 발주 반복 실패', `${o.item_name}: ${errMessage(e)}`, { path: `/orders/${o.id}` });
    return transition(ctx, o, 'SOURCE_ERROR', `발주 실패: ${errMessage(e)}`, actor);
  }
}

/** 처리 대기 주문 일괄 진행(스케줄러) */
export async function processPending(ctx: AppContext): Promise<{ processed: number }> {
  const s = await ctx.settings.get();
  if (s.killSwitch) return { processed: 0 };
  const rows = await ctx.db.selectFrom('orders').select(['id', 'status']).where('status', 'in', ['NEW', 'SOURCE_ERROR']).orderBy('id').execute();
  let processed = 0;
  for (const r of rows) {
    if (r.status === 'SOURCE_ERROR' && (await sourceRetryCount(ctx, r.id)) >= MAX_SOURCE_RETRIES) continue;
    try {
      await processOrder(ctx, r.id);
      processed++;
    } catch (e) {
      ctx.log.error({ order: r.id, err: errMessage(e) }, 'processOrder 실패');
    }
  }
  return { processed };
}

// ── 3. 관리자 액션 ─────────────────────────────────────────────────

/** 구매 대행 작업 완료(사람이 원 쇼핑몰에서 결제 후 입력) 또는 결제 필요 건 결제 완료 */
export async function confirmPurchase(ctx: AppContext, orderId: number, input: { sourceOrderId?: string; cost?: number; shippingCost?: number }, actor: string): Promise<OrderRow> {
  const o = await getOrder(ctx, orderId);
  if (!['AWAITING_PURCHASE', 'PAYMENT_PENDING', 'OUT_OF_STOCK', 'MARGIN_NEGATIVE', 'LIMIT_EXCEEDED', 'SOURCE_ERROR', 'MANUAL_REVIEW'].includes(o.status)) {
    throw new OrderError(`구매 확인할 수 없는 상태: ${STATUS_LABEL[o.status as OrderStatus]}`);
  }
  const sourceOrderId = input.sourceOrderId?.trim() || o.source_order_id;
  if (!sourceOrderId) throw new OrderError('원주문번호를 입력하세요');
  if (!o.acked_at) {
    const ack = (await ctx.market.acknowledge([o.shipment_box_id]))[o.shipment_box_id];
    if (!ack?.ok) throw new OrderError(`쿠팡 상품준비중 처리 실패: ${ack?.message}`);
  }
  await audit(ctx, actor, 'order.purchase_confirmed', String(o.id), { sourceOrderId, cost: input.cost });
  return transition(ctx, o, 'PURCHASED', '구매 확인', actor, {
    source_order_id: sourceOrderId,
    purchase_cost: input.cost ?? o.purchase_cost ?? o.expected_cost,
    purchase_shipping: input.shippingCost ?? o.purchase_shipping ?? 0,
    purchase_strategy: o.purchase_strategy ?? 'assisted',
    purchased_at: ctx.clock.now(),
    acked_at: o.acked_at ?? ctx.clock.now(),
  });
}

/** 예외 건을 확인 후 강행(한도·마진·재고 무시하고 발주 단계 진행) */
export async function overrideAndProcess(ctx: AppContext, orderId: number, actor: string): Promise<OrderRow> {
  const o = await getOrder(ctx, orderId);
  if (!['LIMIT_EXCEEDED', 'MARGIN_NEGATIVE', 'OUT_OF_STOCK', 'SOURCE_ERROR', 'MANUAL_REVIEW'].includes(o.status)) throw new OrderError('강행할 수 없는 상태');
  await audit(ctx, actor, 'order.override', String(o.id), { from: o.status });
  const back = await transition(ctx, o, 'NEW', `관리자 강행(${o.status})`, actor);
  return processOrder(ctx, back.id, { override: true, actor });
}

export function resolveCourierCode(aliases: Record<string, string>, courier: string): string | null {
  const c = courier.trim();
  if (!c) return null;
  if (/^[A-Z0-9_]+$/.test(c)) return c;
  const norm = c.replace(/\s+/g, '');
  if (aliases[norm]) return aliases[norm]!;
  for (const [name, code] of Object.entries(aliases)) if (norm.includes(name.replace(/\s+/g, ''))) return code;
  return null;
}

/** 송장 등록(사람 입력 또는 공급처 API 조회 결과) → 쿠팡 업로드 */
export async function submitTracking(ctx: AppContext, orderId: number, courier: string, trackingNo: string, actor: string): Promise<OrderRow> {
  const s = await ctx.settings.get();
  let o = await getOrder(ctx, orderId);
  if (!['PURCHASED', 'SHIPPING_DELAYED', 'ADDRESS_CHANGED', 'MANUAL_REVIEW'].includes(o.status)) throw new OrderError(`송장 등록할 수 없는 상태: ${STATUS_LABEL[o.status as OrderStatus]}`);
  const code = resolveCourierCode(s.orders.courierAliases, courier);
  if (!code) throw new OrderError(`택배사 코드를 알 수 없음: ${courier} (설정 > 택배사 별칭에 추가)`);
  const no = trackingNo.replace(/[^0-9A-Za-z]/g, '');
  if (!no) throw new OrderError('송장번호가 비었습니다');
  o = await ctx.db.updateTable('orders').set({ courier_code: code, tracking_no: no, updated_at: ctx.clock.now() }).where('id', '=', o.id).returningAll().executeTakeFirstOrThrow();
  if (s.killSwitch) return o;
  const res = await ctx.market.uploadInvoice({ shipmentBoxId: o.shipment_box_id, marketOrderId: o.market_order_id, vendorItemId: o.vendor_item_id, courierCode: code, trackingNo: no });
  if (res.ok) return transition(ctx, o, 'TRACKING_UPLOADED', res.dryRun ? 'DRY_RUN 송장 업로드' : '송장 업로드', actor, { tracking_uploaded_at: ctx.clock.now() });
  if (res.retryable) {
    ctx.log.warn({ order: o.id, msg: res.message }, '송장 업로드 재시도 예정');
    return o;
  }
  await ctx.notifications.notify('error', '송장 업로드 실패', `${o.item_name}: ${res.message}`, { path: `/orders/${o.id}` });
  return transition(ctx, o, 'MANUAL_REVIEW', `송장 업로드 실패: ${res.message}`, actor);
}

// ── 4. 송장 회수·배송 추적 ────────────────────────────────────────

export async function pollFulfillment(ctx: AppContext): Promise<{ tracked: number; uploaded: number; delivered: number }> {
  const s = await ctx.settings.get();
  let tracked = 0, uploaded = 0, delivered = 0;
  if (!s.killSwitch) {
    const purchased = await ctx.db.selectFrom('orders').selectAll().where('status', 'in', ['PURCHASED', 'SHIPPING_DELAYED']).execute();
    for (const o of purchased) {
      try {
        // 이미 입력된 송장(업로드 재시도 대상)
        if (o.tracking_no && o.courier_code) {
          const r = await submitTracking(ctx, o.id, o.courier_code, o.tracking_no, SYSTEM);
          if (r.status === 'TRACKING_UPLOADED') uploaded++;
          continue;
        }
        const sp = o.source_product_id ? await ctx.db.selectFrom('source_products').select(['source']).where('id', '=', o.source_product_id).executeTakeFirst() : undefined;
        const source = sp ? ctx.sources.get(sp.source) : undefined;
        if (!source?.getTracking || !source.capabilities.apiTracking || !o.source_order_id || o.source_order_id.startsWith('DRY-')) continue;
        const t = await source.getTracking(o.source_order_id);
        if (t?.trackingNo) {
          tracked++;
          const r = await submitTracking(ctx, o.id, t.courierName, t.trackingNo, `source:${sp!.source}`);
          if (r.status === 'TRACKING_UPLOADED') uploaded++;
        }
      } catch (e) {
        ctx.log.warn({ order: o.id, err: errMessage(e) }, '송장 처리 실패');
      }
    }
  }
  // 배송 상태 동기화(감지는 kill switch와 무관)
  const shipping = await ctx.db.selectFrom('orders').selectAll().where('status', 'in', ['TRACKING_UPLOADED', 'IN_TRANSIT']).execute();
  for (const o of shipping) {
    try {
      const line = (await ctx.market.getOrderLines(o.shipment_box_id)).find((l) => l.vendorItemId === o.vendor_item_id);
      if (!line) continue;
      if (line.status === 'FINAL_DELIVERY') {
        await transition(ctx, o, 'DELIVERED', '배송완료', SYSTEM, { delivered_at: ctx.clock.now(), market_status: line.status });
        delivered++;
      } else if (line.status === 'DELIVERING' && o.status === 'TRACKING_UPLOADED') {
        await transition(ctx, o, 'IN_TRANSIT', '배송중', SYSTEM, { market_status: line.status });
      }
    } catch (e) {
      ctx.log.warn({ order: o.id, err: errMessage(e) }, '배송상태 조회 실패');
    }
  }
  return { tracked, uploaded, delivered };
}

// ── 5. 취소·반품 감지 ─────────────────────────────────────────────

export async function pollClaims(ctx: AppContext): Promise<{ claims: number }> {
  const now = ctx.clock.now();
  const claims = await ctx.market.listClaims(addDays(now, -3), now);
  let n = 0;
  for (const c of claims) {
    let q = ctx.db.selectFrom('orders').selectAll().where('market_order_id', '=', c.marketOrderId);
    if (c.vendorItemId) q = q.where('vendor_item_id', '=', c.vendorItemId);
    const orders = await q.execute();
    for (const o of orders) {
      const st = o.status as OrderStatus;
      if (c.type === 'CANCEL') {
        if (['CANCELLED', 'CANCEL_REQUESTED', 'RETURNED'].includes(st)) continue;
        // 아직 구매 전이면 그대로 취소 처리(구매 불필요)
        if (isPrePurchase(st) && !o.source_order_id) {
          await transition(ctx, o, 'CANCELLED', `고객 취소: ${c.reason}`, SYSTEM);
        } else {
          await transition(ctx, o, 'CANCEL_REQUESTED', `취소 요청(${c.status}): ${c.reason}`, SYSTEM);
          await ctx.notifications.notify('warn', '구매 후 취소 요청', `${o.item_name}: 공급처 주문(${o.source_order_id ?? '-'}) 취소/반품 처리가 필요합니다.`, { path: `/orders/${o.id}` });
        }
        n++;
      } else {
        if (['RETURN_REQUESTED', 'RETURNED', 'CANCELLED'].includes(st)) continue;
        if (!canTransition(st, 'RETURN_REQUESTED')) continue;
        await transition(ctx, o, 'RETURN_REQUESTED', `반품 요청(${c.status}): ${c.reason}`, SYSTEM);
        await ctx.notifications.notify('warn', '반품 요청', `${o.item_name}: ${c.reason}. 공급처 반품 접수가 필요합니다.`, { path: `/orders/${o.id}` });
        n++;
      }
    }
  }
  return { claims: n };
}

// ── 6. 지연 경고·개인정보 파기 ───────────────────────────────────

export async function checkDelays(ctx: AppContext): Promise<{ alerts: number }> {
  const s = await ctx.settings.get();
  const now = ctx.clock.now();
  let alerts = 0;
  const pending = await ctx.db.selectFrom('orders').selectAll().where('status', 'in', ['AWAITING_PURCHASE', 'PAYMENT_PENDING', 'PURCHASED']).execute();
  for (const o of pending) {
    const since = (o.status === 'PURCHASED' ? o.purchased_at : o.updated_at) ?? o.created_at;
    const hours = (now.getTime() - new Date(since).getTime()) / 3600_000;
    const limit = o.status === 'PURCHASED' ? s.orders.trackingAlertHours : s.orders.purchaseAlertHours;
    const dueToday = o.ship_by && o.ship_by <= kstDate(now);
    if (hours < limit && !dueToday) continue;
    if (o.alerted_at && now.getTime() - new Date(o.alerted_at).getTime() < 6 * 3600_000) continue;
    alerts++;
    await ctx.db.updateTable('orders').set({ alerted_at: now }).where('id', '=', o.id).execute();
    if (o.status === 'PURCHASED' && hours >= limit) {
      await transition(ctx, o, 'SHIPPING_DELAYED', `구매 후 ${Math.floor(hours)}시간 송장 없음`, SYSTEM);
      await ctx.notifications.notify('warn', '송장 지연', `${o.item_name}: 구매 후 ${Math.floor(hours)}시간째 송장이 없습니다. 공급처 확인 필요.`, { path: `/orders/${o.id}` });
    } else {
      await ctx.notifications.notify('action', dueToday ? '오늘 출고기한 주문' : '미처리 구매 작업', `${o.item_name} — ${STATUS_LABEL[o.status as OrderStatus]} (${Math.floor(hours)}시간 경과)`, { path: `/orders/${o.id}` });
    }
  }
  return { alerts };
}

export async function purgePii(ctx: AppContext): Promise<{ purged: number }> {
  const s = await ctx.settings.get();
  const cutoff = addDays(ctx.clock.now(), -s.orders.piiRetentionDays);
  const r = await ctx.db
    .updateTable('orders')
    .set({ receiver_name_enc: null, receiver_phone_enc: null, receiver_addr_enc: null, delivery_message_enc: null, receiver_zip: null, pii_purged_at: ctx.clock.now() })
    .where('pii_purged_at', 'is', null)
    .where((eb) => eb.or([
      eb.and([eb('delivered_at', 'is not', null), eb('delivered_at', '<', cutoff)]),
      eb.and([eb('status', 'in', ['CANCELLED', 'RETURNED']), eb('updated_at', '<', cutoff)]),
    ]))
    .executeTakeFirst();
  return { purged: Number(r.numUpdatedRows ?? 0) };
}
