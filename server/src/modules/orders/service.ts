import { isLive } from '../../config/env.js';
import { allMarkets, type AppContext, audit, MARKET_LABEL, marketFor } from '../../context.js';
import type { OrderRow } from '../../db/schema.js';
import { hashAddress } from '../../lib/crypto.js';
import { maskName } from '../../lib/logger.js';
import { addDays, errMessage, kstDate } from '../../lib/util.js';
import type { MarketOrderLine } from '../../ports/market.js';
import type { SourceTracking } from '../../ports/source.js';
import { upsertSourceProduct } from '../catalog.js';
import { pauseItem, pauseListing } from '../listing/control.js';
import { supplyProblem } from '../sync/service.js';
import { canOrderQty, describeOrderQty, orderQtyIssue } from '../orderQty.js';
import { findByVendorItem } from '../listing/items.js';
import { computeProfit } from '../pricing/pricing.js';
import { COUPANG_COURIERS, courierName, resolveCourier } from './couriers.js';
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
  const out = { fetched: 0, inserted: 0 };
  for (const m of allMarkets(ctx)) {
    // 쿠팡 외 채널은 연결·사용 설정된 경우만(스마트스토어: naver.enabled)
    if (m !== ctx.market && !(await channelEnabled(ctx, m.name))) continue;
    try {
      const r = await pollMarketOrders(ctx, m);
      out.fetched += r.fetched;
      out.inserted += r.inserted;
    } catch (e) {
      // 쿠팡 수집 실패는 기존처럼 작업 실패로(감시·알림), 다른 채널 실패는 쿠팡 수집을 막지 않음
      if (m === ctx.market) throw e;
      ctx.log.error({ market: m.name, err: errMessage(e) }, '주문 수집 실패');
    }
  }
  return out;
}

/**
 * 배송지 변경(스마트스토어는 발주 확인 뒤에도 발송 전이면 고객이 바꿀 수 있음):
 * 새 배송지를 저장하고, 공급처에 이미 주문했으면 공급처 주문의 배송지도 바꾸라고 알림(공급처 API로는 바꿀 수 없음)
 */
async function applyAddressChanges(ctx: AppContext, market: import('../../ports/market.js').MarketPort, from: Date, to: Date): Promise<void> {
  const lines = await market.listAddressChanges!(from, to);
  for (const l of lines) {
    const o = await ctx.db.selectFrom('orders').selectAll().where('market', '=', market.name).where('shipment_box_id', '=', l.shipmentBoxId).where('vendor_item_id', '=', l.vendorItemId).executeTakeFirst();
    if (!o || o.pii_purged_at || ['CANCELLED', 'RETURNED', 'SETTLED', 'DELIVERED', 'IN_TRANSIT', 'TRACKING_UPLOADED'].includes(o.status)) continue;
    const enc = encReceiver(ctx, l);
    if (enc.address_hash === o.address_hash) continue;
    await ctx.db.updateTable('orders').set({ ...enc, updated_at: ctx.clock.now() }).where('id', '=', o.id).execute();
    await ctx.db.insertInto('order_events').values({ order_id: o.id, from_status: o.status, to_status: o.status, reason: `고객이 배송지 변경(${maskName(l.receiver.name)}, ${l.receiver.addr1.slice(0, 12)}…)`, actor: SYSTEM, at: ctx.clock.now() }).execute();
    if (o.source_order_id && !o.source_order_id.startsWith('DRY-')) {
      await ctx.notifications.notify('action', '배송지 변경 — 공급처 주문도 수정하세요', `${o.item_name}: 고객이 배송지를 바꿨습니다. 공급처 주문 ${o.source_order_id}의 배송지를 새 주소로 바꿔 주세요(공급처 1:1 문의). 관리 화면 주문 > 배송지 전체 보기에서 새 주소를 복사할 수 있습니다.`, { path: `/orders/${o.id}`, dedupeKey: `addr-${o.id}-${enc.address_hash}`, dedupeMinutes: 1440 });
    }
  }
}

/** 추가 판매채널 사용 여부(설정 naver.enabled 등) */
export async function channelEnabled(ctx: AppContext, name: string): Promise<boolean> {
  if (name === ctx.market.name) return true;
  if (!ctx.markets?.[name]) return false;
  const s = await ctx.settings.get();
  return name === 'naver' ? s.naver.enabled : false;
}

async function pollMarketOrders(ctx: AppContext, market: import('../../ports/market.js').MarketPort): Promise<{ fetched: number; inserted: number }> {
  const s = await ctx.settings.get();
  const now = ctx.clock.now();
  const key = market === ctx.market ? 'orders.lastPollAt' : `orders.lastPollAt.${market.name}`;
  const last = await ctx.kv.get<string>(key);
  const from = last ? new Date(new Date(last).getTime() - s.coupang.orderPollOverlapMinutes * 60_000) : addDays(now, -1);
  const lines = await market.listOrders(from, now, 'ACCEPT');
  let inserted = 0;
  for (const l of lines) {
    if (l.canceled) continue;
    const res = await ctx.db
      .insertInto('orders')
      .values({
        market: market.name,
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
  if (market.listAddressChanges) await applyAddressChanges(ctx, market, from, now);
  await ctx.kv.set(key, now.toISOString());
  if (market === ctx.market) await ctx.kv.set('orders.lastPollOkAt', now.toISOString());
  else await ctx.kv.set(`orders.lastPollOkAt.${market.name}`, now.toISOString());
  if (inserted && market !== ctx.market) ctx.log.info({ market: market.name, inserted }, '새 주문');
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
      // 고객이 고른 쿠팡 옵션의 공급처 옵션 그대로 확인(그 옵션이 품절이면 다른 옵션으로 보내지 않음)
      const d = await source.getProduct(sp.source_item_id, { title: sp.title, ...(found.option ? { option: found.option } : {}) });
      if (!d || d.status !== 'active' || d.marketSellable === false || (d.stock !== null && d.stock < units)) {
        if (d) await upsertSourceProduct(ctx, sp.source, d);
        const reason = d?.unavailableReason ? `공급처 품절: ${d.unavailableReason}` : '공급처 품절';
        // 여러 옵션을 파는 상품에서 그 옵션만 품절이면 그 옵션만 판매중지(다른 색·사이즈는 계속 판매)
        const item = await ctx.db.selectFrom('listing_items').selectAll().where('vendor_item_id', '=', o.vendor_item_id).executeTakeFirst();
        // 상품 자체는 판매중인지(옵션 고정 없이 다시 조회) — 그렇다면 이 옵션만의 문제
        const whole = item?.source_option ? await source.getProduct(sp.source_item_id, { title: sp.title }).catch(() => null) : null;
        const onlyThisOption = !!item?.source_option && !!whole && !supplyProblem(s, { ...whole, stock: null });
        if (onlyThisOption) {
          for (const it of await ctx.db.selectFrom('listing_items').selectAll().where('listing_id', '=', listing.id).where('source_option', '=', item!.source_option).execute()) await pauseItem(ctx, it, reason);
        } else {
          await pauseListing(ctx, listing, reason);
        }
        if (!opts.override) {
          await ctx.notifications.notify('error', '품절 주문 발생', `${o.item_name} — 공급처 품절. ${onlyThisOption ? `이 옵션(${item!.source_option})만` : '상품'} 판매중지함. 고객 취소 여부를 확인하세요.`, { path: `/orders/${o.id}` });
          return transition(ctx, o, 'OUT_OF_STOCK', '공급처 품절/재고 부족', actor);
        }
      } else {
        await upsertSourceProduct(ctx, sp.source, d);
        price = d.price;
        shipping = d.shippingFee;
        // 공급처 최소 구매수량·구매 단위 때문에 이 수량을 그대로 살 수 없음 → 자동 구매하지 않고 사람에게(상품은 판매중지)
        if (!canOrderQty(d, units)) {
          const rule = describeOrderQty(d);
          await pauseListing(ctx, listing, `공급처 판매 불가: ${orderQtyIssue(d) ?? `공급처 구매 수량 ${rule}`}`);
          if (!opts.override) {
            await ctx.notifications.notify('error', '공급처 최소 구매수량 때문에 발주 불가',
              `${o.item_name} ${units}개 — 공급처는 ${rule}로만 판매합니다. 상품은 판매중지했습니다.\n더 많이 사서 보내거나(남는 수량은 손실) Wing에서 고객에게 안내 후 취소하세요.`, { path: `/orders/${o.id}` });
            return transition(ctx, o, 'MANUAL_REVIEW', `공급처 구매 수량 ${rule} — ${units}개 발주 불가`, actor);
          }
        }
      }
    } catch (e) {
      const n = await sourceRetryCount(ctx, o.id);
      if (n + 1 >= MAX_SOURCE_RETRIES) await ctx.notifications.notify('error', '공급처 조회 반복 실패', `${o.item_name}: ${errMessage(e)}`, { path: `/orders/${o.id}` });
      return transition(ctx, o, 'SOURCE_ERROR', `공급처 조회 실패: ${errMessage(e)}`, actor);
    }
  }

  const cost = price * units;
  const det = sp.detail as { shippingPerUnit?: boolean; maxPerBox?: number | null } | null;
  // 배송비: 개당이면 수량만큼, 상자당 수량 한도가 있으면 상자 수만큼
  if (det?.shippingPerUnit) shipping *= units;
  else if (det?.maxPerBox && units > det.maxPerBox) shipping *= Math.ceil(units / det.maxPerBox);
  const breakdown = computeProfit(s, o.sale_amount, { cost, shipping, categoryPath: sp.category_path, inputVatDeductible: sp.tax_invoice, feeRate: listing.fee_rate_actual });
  o = await ctx.db.updateTable('orders').set({ expected_cost: cost + shipping, expected_profit: breakdown.profit }).where('id', '=', o.id).returningAll().executeTakeFirstOrThrow();

  if (!opts.override) {
    if (breakdown.profit < 0 && breakdown.profit >= -s.orders.maxAutoLossKrw) {
      // 소액 손실: 구매자가 기다리지 않게 그대로 발주하고, 더 팔리지 않게 상품만 멈춤(동기화가 가격 재조정 후 재개)
      await pauseListing(ctx, listing, '마진 역전');
      await ctx.notifications.notify('warn', '소액 손실 주문 — 그대로 발송', `${o.item_name}: 예상 손익 ${breakdown.profit.toLocaleString()}원(허용 ${s.orders.maxAutoLossKrw.toLocaleString()}원 이내). 구매자 보호를 위해 발주하고 상품은 판매중지했습니다(가격 재조정 후 자동 재개).`, { path: `/orders/${o.id}` });
    } else if (breakdown.profit < 0) {
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

  // 실제 쿠팡 주문인데 주문 처리(상품준비중·송장)가 꺼져 있으면 모의 처리하면 안 됨 → 사람에게 넘김
  const real = !listing.dry_run;
  if (real && !isLive(ctx.env, 'LIVE_FULFILLMENT')) return handOver(ctx, o, units, breakdown.profit, 'LIVE_FULFILLMENT', actor);

  // 상품준비중 처리 → 고객 즉시취소 방지. 이후 배송지 재확인(결제완료 단계에서 변경 가능)
  if (!o.acked_at) {
    const ack = (await marketFor(ctx, o.market).acknowledge([o.shipment_box_id]))[o.shipment_box_id];
    if (!ack?.ok) {
      if (ack?.retryable) return transition(ctx, o, 'SOURCE_ERROR', `상품준비중 처리 실패(재시도): ${ack?.message}`, actor);
      const lines = await marketFor(ctx, o.market).getOrderLines(o.shipment_box_id).catch(() => []);
      if (lines.some((l) => l.vendorItemId === o.vendor_item_id && (l.canceled || l.status === 'CANCELED'))) return transition(ctx, o, 'CANCELLED', '고객 취소', actor);
      return transition(ctx, o, 'MANUAL_REVIEW', `상품준비중 처리 실패: ${ack?.message}`, actor);
    }
    const lines = await marketFor(ctx, o.market).getOrderLines(o.shipment_box_id);
    const line = lines.find((l) => l.vendorItemId === o.vendor_item_id);
    const patch: Record<string, unknown> = { acked_at: ctx.clock.now(), market_status: line?.status ?? 'INSTRUCT' };
    if (line) Object.assign(patch, encReceiver(ctx, line));
    o = await ctx.db.updateTable('orders').set(patch).where('id', '=', o.id).returningAll().executeTakeFirstOrThrow();
  }

  // 발주 전략 선택
  const canApi = source.capabilities.apiOrder && typeof source.placeOrder === 'function';
  if (canApi && (s.orders.mode === 'auto' || opts.override)) {
    // 실제 주문은 모의 발주 금지(아무도 안 사는 사고 방지) → 자동 발주가 꺼져 있으면 사람에게
    if (real && !isLive(ctx.env, 'LIVE_ORDERING')) return handOver(ctx, o, units, breakdown.profit, 'LIVE_ORDERING', actor);
    return placeApiOrder(ctx, o, sp.source_item_id, actor, units);
  }

  if (o.status !== 'AWAITING_PURCHASE') {
    o = await transition(ctx, o, 'AWAITING_PURCHASE', canApi ? '승인 모드: 구매 확인 필요' : '공급처 API 발주 불가 → 구매 대행 작업', actor, { purchase_strategy: 'assisted' });
    await ctx.notifications.notify('action', '구매할 주문이 있어요', `${o.item_name} — 공급처에서 ${units}개 구매 (${maskName(decryptReceiver(ctx, o).name)}) — 예상 이익 ${breakdown.profit.toLocaleString()}원`, { path: `/orders/${o.id}` });
  }
  return o;
}

/** 실제 주문인데 자동 처리 스위치가 꺼져 있음 → 구매 필요(사람)로 넘기고 할 일을 구체적으로 알림 */
async function handOver(ctx: AppContext, o: OrderRow, units: number, profit: number, flag: 'LIVE_FULFILLMENT' | 'LIVE_ORDERING', actor: string): Promise<OrderRow> {
  if (o.status === 'AWAITING_PURCHASE') return o;
  const center = o.market === 'naver' ? '스마트스토어센터' : 'Wing';
  const steps = flag === 'LIVE_FULFILLMENT'
    ? `① ${center} 주문관리에서 [발주확인] ② 오너클랜에서 직접 주문 ③ 관리 화면 주문에 원주문번호 입력 ④ 송장은 ${center}에 직접 입력`
    : '① 오너클랜에서 직접 주문 ② 관리 화면 주문에 원주문번호 입력(송장은 자동 등록)';
  o = await transition(ctx, o, 'AWAITING_PURCHASE', `실제 주문 — 자동 처리 꺼짐(${flag}=false)`, actor, { purchase_strategy: 'assisted' });
  await ctx.notifications.notify('action', '실제 주문 — 직접 처리 필요',
    `${o.item_name} ${units}개 (예상 이익 ${profit.toLocaleString()}원)\n.env 의 ${flag} 가 꺼져 있어 자동 처리하지 않았습니다.\n${steps}\n다음부터 자동으로 하려면 ${flag}=true 후 restart.sh`,
    { path: `/orders/${o.id}` });
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
  const s = await ctx.settings.get();
  try {
    // 발주 옵션 = 고객이 고른 쿠팡 옵션의 공급처 옵션(여러 옵션 판매) → 상품 고정 옵션 → 옛 상품만 공급처 스냅샷의 기본 옵션
    const found = await findByVendorItem(ctx, o.vendor_item_id);
    const res = await source.placeOrder!({
      idempotencyKey: key,
      sourceItemId,
      option: found?.option ?? (sp.detail as { defaultOption?: string } | null)?.defaultOption,
      qty: units,
      receiver: { name: r.name, phone: r.phone, addr1: r.addr1, addr2: r.addr2, zip: r.zip },
      sender: { name: s.orders.senderName || r.name, phone: s.orders.senderPhone || s.coupang.companyContactNumber || r.phone },
      deliveryMessage: r.deliveryMessage,
    });
    await audit(ctx, actor, 'order.placed', String(o.id), { source: sp.source, sourceOrderId: res.sourceOrderId, cost: res.cost });
    const patch = { purchase_strategy: 'api', source_order_id: res.sourceOrderId, purchase_cost: res.cost, purchase_shipping: res.shippingCost };
    if (res.needsPayment) {
      await ctx.notifications.notify('action', '공급처 결제가 필요해요', `${o.item_name}: ${source.displayName} 주문 ${res.sourceOrderId} 생성됨. 예치금 결제 후 [결제완료]를 눌러주세요.`, { path: `/orders/${o.id}` });
      return transition(ctx, o, 'PAYMENT_PENDING', '공급처 주문 생성, 결제 필요', actor, patch);
    }
    const done = await transition(ctx, o, 'PURCHASED', `API 발주 완료(${source.displayName})`, actor, { ...patch, purchased_at: ctx.clock.now() });
    await ctx.notifications.notify('info', '새 주문 — 자동 발주 완료', `${o.item_name} ${units}개 — ${source.displayName} 주문 ${res.sourceOrderId} (원가 ${(res.cost + res.shippingCost).toLocaleString()}원, 예상 이익 ${(o.expected_profit ?? 0).toLocaleString()}원). 송장이 나오면 자동으로 쿠팡에 등록합니다.`, { path: `/orders/${o.id}` });
    return done;
  } catch (e) {
    const n = await sourceRetryCount(ctx, o.id);
    // 첫 실패부터 알림(예치금 부족 등은 사람이 바로 조치해야 함), 마지막 재시도 실패 시 다시 알림
    if (n === 0) await ctx.notifications.notify('warn', '자동 발주 실패(자동 재시도 중)', `${o.item_name}: ${errMessage(e)}\n예치금 부족이면 오너클랜 예치금을 충전하세요. 충전 후 자동 재시도됩니다.`, { path: `/orders/${o.id}` });
    else if (n + 1 >= MAX_SOURCE_RETRIES) await ctx.notifications.notify('error', '자동 발주 반복 실패 — 직접 처리 필요', `${o.item_name}: ${errMessage(e)}\n오너클랜에서 직접 주문 후 관리 화면에 원주문번호를 입력하세요.`, { path: `/orders/${o.id}` });
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
    const ack = (await marketFor(ctx, o.market).acknowledge([o.shipment_box_id]))[o.shipment_box_id];
    if (!ack?.ok) throw new OrderError(`${MARKET_LABEL[o.market] ?? o.market} 발주 확인(상품준비중) 처리 실패: ${ack?.message}`);
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

/** 택배사 이름(또는 코드) → 쿠팡 코드. 상세 규칙은 couriers.ts */
export function resolveCourierCode(aliases: Record<string, string>, courier: string, sourceCode?: string | null): string | null {
  return resolveCourier({ name: courier, code: sourceCode }, aliases)?.code ?? null;
}

/**
 * 송장 등록(사람 입력 또는 공급처 API 조회 결과) → 쿠팡 업로드.
 * - courierCode 를 직접 주면(관리 화면에서 택배사 선택) 그 코드로 올리고, 공급처 표기 → 코드를 별칭으로 저장(다음부터 자동)
 * - 택배사를 못 맞추면 송장은 저장하고 "택배사 선택 필요" 알림(하루 1번), 사람이 고르면 진행
 * - 쿠팡이 거절하면 사유별로 안내(형식·택배사 불일치는 공급처가 고치면 자동 재시도, 고객 취소 진행 중이면 취소 흐름에 맡김)
 */
export async function submitTracking(ctx: AppContext, orderId: number, courier: string, trackingNo: string, actor: string, opts: { courierCode?: string; sourceCode?: string | null } = {}): Promise<OrderRow> {
  const s = await ctx.settings.get();
  let o = await getOrder(ctx, orderId);
  if (!['PURCHASED', 'SHIPPING_DELAYED', 'ADDRESS_CHANGED', 'MANUAL_REVIEW'].includes(o.status)) throw new OrderError(`송장 등록할 수 없는 상태: ${STATUS_LABEL[o.status as OrderStatus]}`);
  const no = trackingNo.replace(/[^0-9A-Za-z]/g, '');
  if (!no) throw new OrderError('송장번호가 비었습니다');
  const name = courier.trim();
  const auto = actor.startsWith('source:') || actor === SYSTEM;
  let code: string | null;
  if (opts.courierCode) {
    if (!COUPANG_COURIERS.some(([c]) => c === opts.courierCode)) throw new OrderError(`쿠팡 택배사 코드가 아닙니다: ${opts.courierCode}`);
    code = opts.courierCode;
    // 처음 보는 표기를 사람이 골랐으면 기억(다음 송장부터 자동)
    if (!auto && name && resolveCourier({ name }, s.orders.courierAliases)?.code !== code) {
      await ctx.settings.update({ orders: { courierAliases: { [name.replace(/\s+/g, '')]: code } } } as any);
      await audit(ctx, actor, 'courier.alias', name, { code });
    }
  } else {
    code = resolveCourierCode(s.orders.courierAliases, name, opts.sourceCode);
  }
  if (!code) {
    const label = name || opts.sourceCode || '(이름 없음)';
    o = await ctx.db.updateTable('orders').set({ courier_name: label, tracking_no: no, courier_code: null, invoice_error: `택배사 확인 필요: ${label}`, updated_at: ctx.clock.now() }).where('id', '=', o.id).returningAll().executeTakeFirstOrThrow();
    await ctx.notifications.notify('action', '택배사 선택 필요', `${o.item_name}: 공급처 송장 ${no}의 택배사 "${label}"를 쿠팡 택배사로 맞추지 못했습니다.\n관리 화면 주문 > [송장 입력]에서 택배사를 고르면 쿠팡에 등록되고, 다음부터는 자동으로 처리됩니다.`, { path: `/orders/${o.id}`, dedupeKey: `courier-${o.id}-${label}`, dedupeMinutes: 1440 });
    if (auto) return o;
    throw new OrderError(`택배사를 알 수 없음: ${label} — 목록에서 택배사를 고르세요`);
  }
  const changed = o.tracking_no !== no || o.courier_code !== code;
  o = await ctx.db.updateTable('orders').set({
    courier_name: name || o.courier_name, courier_code: code, tracking_no: no, updated_at: ctx.clock.now(),
    ...(changed ? { invoice_attempts: 0, invoice_error: null } : {}),
  }).where('id', '=', o.id).returningAll().executeTakeFirstOrThrow();
  if (s.killSwitch) return o;
  if (!isLive(ctx.env, 'LIVE_FULFILLMENT') && (await isRealOrder(ctx, o))) {
    // 실제 주문인데 송장 자동 등록이 꺼져 있음 → 모의 업로드로 '등록됨' 처리하면 쿠팡엔 송장이 없음
    await ctx.notifications.notify('action', '송장 직접 입력 필요', `${o.item_name}: ${courierName(code)} ${no}\n${o.market === 'naver' ? '스마트스토어센터' : 'Wing'} 주문관리에서 송장을 입력하세요(LIVE_FULFILLMENT=false).`, { path: `/orders/${o.id}`, dedupeKey: `manual-invoice-${o.id}`, dedupeMinutes: 720 });
    return o.status === 'MANUAL_REVIEW' ? o : transition(ctx, o, 'MANUAL_REVIEW', '송장 직접 입력 필요(자동 등록 꺼짐)', actor);
  }
  // 고객 취소 요청(출고중지요청)이 열려 있으면 일반 송장 등록 대신 취소 흐름이 처리(공급처가 이미 보냈으면 이미출고/발송 처리)
  const stopReq = await ctx.db.selectFrom('order_claims').select('id').where('order_id', '=', o.id).where('stage', '=', 'stop_requested').where('closed_at', 'is', null).executeTakeFirst();
  if (stopReq) {
    ctx.log.info({ order: o.id }, '취소 요청 진행 중이라 송장 등록 보류(취소 흐름이 처리)');
    return o;
  }
  // 같은 묶음배송에 다른 상품이 있으면(공급처별로 따로 출고) 분리배송으로 등록
  const siblings = await ctx.db.selectFrom('orders').select(['status']).where('shipment_box_id', '=', o.shipment_box_id).where('id', '!=', o.id).execute();
  const res = await marketFor(ctx, o.market).uploadInvoice({
    shipmentBoxId: o.shipment_box_id, marketOrderId: o.market_order_id, vendorItemId: o.vendor_item_id, courierCode: code, trackingNo: no,
    splitShipping: siblings.length > 0,
    preSplitShipped: siblings.some((x) => ['TRACKING_UPLOADED', 'IN_TRANSIT', 'DELIVERED', 'SETTLED'].includes(x.status)),
  });
  if (res.ok) {
    return transition(ctx, o, 'TRACKING_UPLOADED', `${res.dryRun ? 'DRY_RUN 송장 업로드' : '송장 업로드'}: ${courierName(code)} ${no}`, actor, { tracking_uploaded_at: ctx.clock.now(), tracking_checked_at: ctx.clock.now(), invoice_error: null, invoice_attempts: 0 });
  }
  const attempts = o.invoice_attempts + 1;
  o = await ctx.db.updateTable('orders').set({ invoice_attempts: attempts, invoice_error: res.message }).where('id', '=', o.id).returningAll().executeTakeFirstOrThrow();
  // 고객 취소(출고중지요청) 진행 중 → 송장을 올리지 않고 취소 흐름(claims)에 맡김
  if (/ORDER_DELIVERY_(CANCELED|PARTIAL_STOP)/.test(res.message)) {
    ctx.log.warn({ order: o.id, msg: res.message }, '취소 진행 중이라 송장 등록 보류');
    return o;
  }
  const hint = invoiceHint(res.message, courierName(code));
  if (res.retryable) {
    ctx.log.warn({ order: o.id, msg: res.message, attempts }, '송장 업로드 재시도 예정');
    // 3번 연속 실패하면 알림(공급처가 송장을 고치면 자동으로 다시 시도)
    if (attempts >= 3) await ctx.notifications.notify('error', '송장 등록 반복 실패', `${o.item_name}: ${courierName(code)} ${no} — ${res.message}\n${hint}`, { path: `/orders/${o.id}`, dedupeKey: `invoice-fail-${o.id}-${no}`, dedupeMinutes: 1440 });
    return o;
  }
  await ctx.notifications.notify('error', '송장 업로드 실패', `${o.item_name}: ${courierName(code)} ${no} — ${res.message}\n${hint}`, { path: `/orders/${o.id}`, dedupeKey: `invoice-fail-${o.id}-${no}`, dedupeMinutes: 1440 });
  // 공급처 송장 형식 오류는 공급처가 고치면 자동 회수가 새 송장으로 재시도하도록 구매완료에 둠
  if (auto && /INVALID_FORMAT|INVALID_INVOICE_NUMBER|DUPLICATE_INVOICE_NUMBER/.test(res.message)) return o;
  return transition(ctx, o, 'MANUAL_REVIEW', `송장 업로드 실패: ${res.message}`, actor);
}

/** 쿠팡 송장 거절 사유 → 할 일 */
function invoiceHint(message: string, courier: string): string {
  if (/INVALID_FORMAT|INVALID_INVOICE_NUMBER/.test(message)) return `송장번호가 ${courier} 형식과 맞지 않습니다. 공급처 송장이 틀렸거나 택배사가 다를 수 있어요 — 공급처 주문에서 택배사·송장을 확인하고 관리 화면 [송장 입력]에서 바로잡으세요(공급처가 고치면 자동 재시도).`;
  if (/DUPLICATE_INVOICE_NUMBER|NOT_ALLOW_INVOICE_NUMBER_RE_UPLOAD/.test(message)) return '이미 다른 주문에 쓰인 송장번호입니다(공급처 송장 재사용·오입력). 공급처에 올바른 송장을 요청하세요.';
  if (/INVALID_STATUS|ORDER_DELIVERY/.test(message)) return '쿠팡 주문 상태가 송장을 받을 수 없는 상태입니다(취소·출고중지 등). Wing 주문 상태를 확인하세요.';
  return 'Wing 주문관리에서 직접 송장을 입력하거나 잠시 후 다시 시도하세요.';
}

async function sourceOrderInfo(ctx: AppContext, o: OrderRow) {
  if (!o.source_order_id || o.source_order_id.startsWith('DRY-') || !o.source_product_id) return null;
  const sp = await ctx.db.selectFrom('source_products').select('source').where('id', '=', o.source_product_id).executeTakeFirst();
  const src = sp ? ctx.sources.get(sp.source) : undefined;
  return src?.getOrderInfo ? src.getOrderInfo(o.source_order_id) : null;
}

/** 공급사가 주문을 취소(품절 등) → 고객 주문 취소 처리 필요 + 상품 판매중지 */
async function supplierCancelled(ctx: AppContext, o: OrderRow, raw: string): Promise<void> {
  await transition(ctx, o, 'MANUAL_REVIEW', `공급처 주문 취소됨(${raw})`, SYSTEM);
  if (o.listing_id) {
    const l = await ctx.db.selectFrom('listings').selectAll().where('id', '=', o.listing_id).executeTakeFirst();
    if (l) await pauseListing(ctx, l, '공급처 품절');
  }
  await ctx.notifications.notify('error', '공급처가 주문을 취소했어요', `${o.item_name}: 공급처 주문 ${o.source_order_id} 이 취소됐습니다(품절 등). 상품은 판매중지했습니다.\nWing에서 고객 주문을 취소(품절 사유)하거나 다른 곳에서 구매해 보내세요.`, { path: `/orders/${o.id}` });
}

/** 실제 쿠팡 상품의 주문인지(모의 등록 상품 주문이 아님) */
async function isRealOrder(ctx: AppContext, o: OrderRow): Promise<boolean> {
  if (o.vendor_item_id.startsWith('DRYVI-')) return false;
  if (!o.listing_id) return true;
  const l = await ctx.db.selectFrom('listings').select('dry_run').where('id', '=', o.listing_id).executeTakeFirst();
  return !l?.dry_run;
}

// ── 4. 송장 회수·배송 추적 ────────────────────────────────────────

export async function pollFulfillment(ctx: AppContext): Promise<{ tracked: number; uploaded: number; delivered: number }> {
  const s = await ctx.settings.get();
  let tracked = 0, uploaded = 0, delivered = 0;
  if (!s.killSwitch) {
    // 결제 대기(공급처 주문 생성됨) → 결제되면 자동으로 구매완료
    for (const o of await ctx.db.selectFrom('orders').selectAll().where('status', '=', 'PAYMENT_PENDING').execute()) {
      try {
        const info = await sourceOrderInfo(ctx, o);
        if (info?.state === 'ok') await transition(ctx, o, 'PURCHASED', `공급처 결제 확인(${info.rawStatus})`, SYSTEM, { purchased_at: ctx.clock.now() });
        else if (info?.state === 'cancelled') await supplierCancelled(ctx, o, info.rawStatus);
      } catch (e) {
        ctx.log.warn({ order: o.id, err: errMessage(e) }, '결제 상태 조회 실패');
      }
    }
    const purchased = await ctx.db.selectFrom('orders').selectAll().where('status', 'in', ['PURCHASED', 'SHIPPING_DELAYED']).execute();
    for (const o of purchased) {
      try {
        const sp = o.source_product_id ? await ctx.db.selectFrom('source_products').select(['source']).where('id', '=', o.source_product_id).executeTakeFirst() : undefined;
        const source = sp ? ctx.sources.get(sp.source) : undefined;
        const apiTracking = !!source?.getTracking && !!source.capabilities.apiTracking && !!o.source_order_id && !o.source_order_id.startsWith('DRY-');
        if (!source || !apiTracking) {
          // 사람이 입력한 송장(업로드 재시도 대상)
          if (o.tracking_no && o.courier_code) {
            const r = await submitTracking(ctx, o.id, o.courier_name ?? o.courier_code, o.tracking_no, SYSTEM, { courierCode: o.courier_code });
            if (r.status === 'TRACKING_UPLOADED') uploaded++;
          }
          continue;
        }
        let t: SourceTracking | null;
        if (source.getOrderInfo) {
          const info = await source.getOrderInfo(o.source_order_id!);
          if (info.state === 'cancelled' && !info.tracking) {
            await supplierCancelled(ctx, o, info.rawStatus);
            continue;
          }
          t = info.tracking;
        } else t = await source.getTracking!(o.source_order_id!);
        if (t?.trackingNo) {
          tracked++;
          // 공급처 표기를 못 맞춰 사람이 택배사를 골라 둔 같은 송장이면 그 코드로
          const manualCode = o.tracking_no === t.trackingNo && o.courier_code ? o.courier_code : undefined;
          const r = await submitTracking(ctx, o.id, t.courierName, t.trackingNo, `source:${sp!.source}`, { sourceCode: t.courierCode, courierCode: manualCode });
          if (r.status === 'TRACKING_UPLOADED') uploaded++;
        }
      } catch (e) {
        ctx.log.warn({ order: o.id, err: errMessage(e) }, '송장 처리 실패');
        if (e instanceof OrderError) await ctx.notifications.notify('warn', '송장 자동 등록 실패', `${o.item_name}: ${errMessage(e)}`, { path: `/orders/${o.id}`, dedupeKey: `track-fail-${o.id}`, dedupeMinutes: 1440 });
      }
    }
  }
  // 배송 상태 동기화(감지는 kill switch와 무관)
  // 스마트스토어는 매출내역 API 대신 구매확정 시 정산 예정 금액으로 정산(배송완료 주문도 계속 확인)
  const shipping = await ctx.db.selectFrom('orders').selectAll()
    .where((eb) => eb.or([eb('status', 'in', ['TRACKING_UPLOADED', 'IN_TRANSIT']), eb.and([eb('status', '=', 'DELIVERED'), eb('market', '!=', ctx.market.name)])]))
    .execute();
  for (const o of shipping) {
    try {
      const line = (await marketFor(ctx, o.market).getOrderLines(o.shipment_box_id)).find((l) => l.vendorItemId === o.vendor_item_id);
      if (!line) continue;
      if (line.status === 'FINAL_DELIVERY') {
        let cur = o;
        if (o.status !== 'DELIVERED') {
          cur = await transition(ctx, o, 'DELIVERED', '배송완료', SYSTEM, { delivered_at: ctx.clock.now(), market_status: line.status });
          delivered++;
        }
        if (line.decided && typeof line.settlementAmount === 'number') {
          const profit = line.settlementAmount - (cur.purchase_cost ?? cur.expected_cost ?? 0) - (cur.purchase_shipping ?? 0) - (cur.extra_cost ?? 0);
          // 실제 수수료율 = 1 - 정산 예정 금액 / 결제 금액(무료배송이라 배송비 없음) → 상품별 지수평균(가격 계산에 사용)
          if (cur.listing_id && cur.sale_amount > 0) {
            const ratio = 1 - line.settlementAmount / cur.sale_amount;
            if (ratio > 0 && ratio < 0.3) {
              const l = await ctx.db.selectFrom('listings').select(['fee_rate_actual']).where('id', '=', cur.listing_id).executeTakeFirst();
              const next = l?.fee_rate_actual ? l.fee_rate_actual * 0.7 + ratio * 0.3 : ratio;
              await ctx.db.updateTable('listings').set({ fee_rate_actual: Math.round(next * 10000) / 10000 }).where('id', '=', cur.listing_id).execute();
            }
          }
          await transition(ctx, cur, 'SETTLED', `구매확정 — 정산 예정 ${line.settlementAmount.toLocaleString()}원`, SYSTEM, { settlement_amount: line.settlementAmount, profit, settled_at: ctx.clock.now() });
        }
        continue;
      }
      if (line.status === 'DELIVERING' && o.status === 'TRACKING_UPLOADED') {
        await transition(ctx, o, 'IN_TRANSIT', '배송중', SYSTEM, { market_status: line.status });
        continue;
      }
      if (o.market_status !== line.status) await ctx.db.updateTable('orders').set({ market_status: line.status }).where('id', '=', o.id).execute();
      if (o.status === 'TRACKING_UPLOADED' && !s.killSwitch) await watchStuckShipment(ctx, o, line.status);
    } catch (e) {
      ctx.log.warn({ order: o.id, err: errMessage(e) }, '배송상태 조회 실패');
    }
  }
  return { tracked, uploaded, delivered };
}

/**
 * 송장 등록 후 배송이 움직이지 않음(쿠팡 배송지시에 머묾):
 * - 12시간 뒤부터 6시간마다 공급처 송장을 다시 확인 → 공급처가 송장·택배사를 고쳤으면 쿠팡 송장 수정
 * - orders.trackingStuckHours(기본 72시간) 넘게 그대로면 알림(틀린 송장으로 고객이 취소하면 배송비 판매자 부담)
 * 업체직송(DIRECT)은 배송조회가 없으므로 제외
 */
async function watchStuckShipment(ctx: AppContext, o: OrderRow, marketStatus: string): Promise<void> {
  const s = await ctx.settings.get();
  if (o.courier_code === 'DIRECT' || marketStatus === 'NONE_TRACKING') return;
  const now = ctx.clock.now();
  const since = o.tracking_uploaded_at ? new Date(o.tracking_uploaded_at).getTime() : now.getTime();
  const hours = (now.getTime() - since) / 3600_000;
  if (hours < 12) return;
  if (!o.tracking_checked_at || now.getTime() - new Date(o.tracking_checked_at).getTime() >= 6 * 3600_000) {
    await ctx.db.updateTable('orders').set({ tracking_checked_at: now }).where('id', '=', o.id).execute();
    const info = await sourceOrderInfo(ctx, o).catch(() => null);
    const t = info?.tracking;
    if (t?.trackingNo) {
      const code = resolveCourierCode(s.orders.courierAliases, t.courierName, t.courierCode);
      const mk = marketFor(ctx, o.market);
      if (code && (t.trackingNo !== o.tracking_no || code !== o.courier_code) && mk.updateInvoice) {
        const r = await mk.updateInvoice({ shipmentBoxId: o.shipment_box_id, marketOrderId: o.market_order_id, vendorItemId: o.vendor_item_id, courierCode: code, trackingNo: t.trackingNo });
        await audit(ctx, SYSTEM, 'order.invoice_update', String(o.id), { from: `${o.courier_code} ${o.tracking_no}`, to: `${code} ${t.trackingNo}`, ...r });
        if (r.ok) {
          await ctx.db.updateTable('orders').set({ courier_code: code, courier_name: t.courierName, tracking_no: t.trackingNo, tracking_uploaded_at: now }).where('id', '=', o.id).execute();
          await ctx.db.insertInto('order_events').values({ order_id: o.id, from_status: o.status, to_status: o.status, reason: `공급처 송장 변경 → 쿠팡 송장 수정: ${courierName(code)} ${t.trackingNo}`, actor: SYSTEM, at: now }).execute();
          await ctx.notifications.notify('info', '송장 수정 반영', `${o.item_name}: 공급처가 송장을 바꿔 쿠팡 송장도 수정했습니다(${courierName(o.courier_code ?? '')} ${o.tracking_no} → ${courierName(code)} ${t.trackingNo}).`, { path: `/orders/${o.id}` });
          return;
        }
        await ctx.notifications.notify('error', '송장 수정 실패', `${o.item_name}: 공급처 송장이 ${courierName(code)} ${t.trackingNo}로 바뀌었지만 쿠팡 수정 실패(${r.message}). Wing 주문관리에서 송장을 수정하세요.`, { path: `/orders/${o.id}`, dedupeKey: `invoice-update-${o.id}-${t.trackingNo}`, dedupeMinutes: 1440 });
      }
    }
  }
  if (hours >= s.orders.trackingStuckHours) {
    await ctx.notifications.notify('warn', '배송 조회가 안 돼요', `${o.item_name}: 송장 ${courierName(o.courier_code ?? '')} ${o.tracking_no} 등록 후 ${Math.floor(hours)}시간째 쿠팡에 배송 시작이 잡히지 않습니다.\n공급처에 실제 발송 여부·송장번호·택배사를 확인하세요(틀린 송장으로 고객이 취소하면 배송비는 판매자 부담). 공급처가 송장을 고치면 자동으로 쿠팡 송장을 수정합니다.`, { path: `/orders/${o.id}`, dedupeKey: `stuck-${o.id}`, dedupeMinutes: 1440 * 3 });
  }
}

// ── 5. 취소·반품·교환 → claims.ts ─────────────────────────────────

export { pollClaims } from './claims.js';

// ── 6. 지연 경고·개인정보 파기 ───────────────────────────────────

export async function checkDelays(ctx: AppContext): Promise<{ alerts: number; delayed?: number }> {
  const s = await ctx.settings.get();
  const now = ctx.clock.now();
  let alerts = 0;
  const delayed = await delayDispatches(ctx);
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
  return { alerts, ...(delayed ? { delayed } : {}) };
}

/**
 * 발송 지연 처리(채널이 지원할 때 — 스마트스토어): 발송 기한이 오늘(한국시간)인데 아직 송장이 없는 주문은
 * 기한을 orders.dispatchDelayDays(2)일 미루고 사유(상품 준비 중)를 등록한다. 기한을 넘기면 판매 페널티.
 * 주문당 최대 2번(그래도 안 보내면 사람이 공급처 확인).
 */
async function delayDispatches(ctx: AppContext): Promise<number> {
  const s = await ctx.settings.get();
  if (s.killSwitch) return 0;
  const today = kstDate(ctx.clock.now());
  const rows = await ctx.db.selectFrom('orders').selectAll().where('market', '!=', ctx.market.name)
    .where('status', 'in', ['NEW', 'AWAITING_PURCHASE', 'PAYMENT_PENDING', 'PURCHASED', 'SHIPPING_DELAYED', 'SOURCE_ERROR', 'MANUAL_REVIEW', 'OUT_OF_STOCK', 'LIMIT_EXCEEDED', 'MARGIN_NEGATIVE'])
    .where('tracking_no', 'is', null).where('ship_by', '<=', today).execute();
  let n = 0;
  for (const o of rows) {
    const market = marketFor(ctx, o.market);
    if (!market.delayDispatch || !o.acked_at) continue;
    const done = Number((await ctx.db.selectFrom('order_events').select((eb) => eb.fn.countAll<number>().as('n')).where('order_id', '=', o.id).where('reason', 'like', '발송 지연 처리%').executeTakeFirst())?.n ?? 0);
    if (done >= 2) continue;
    const due = addDays(new Date(`${o.ship_by}T23:59:00+09:00`), s.orders.dispatchDelayDays);
    const r = await market.delayDispatch(o.shipment_box_id, due, '공급처 출고 준비 중(위탁 배송) — 출고되는 대로 바로 발송합니다.');
    await audit(ctx, SYSTEM, 'order.delay_dispatch', String(o.id), { due: kstDate(due), ...r });
    if (r.ok) {
      n++;
      await ctx.db.updateTable('orders').set({ ship_by: kstDate(due), updated_at: ctx.clock.now() }).where('id', '=', o.id).execute();
      await ctx.db.insertInto('order_events').values({ order_id: o.id, from_status: o.status, to_status: o.status, reason: `발송 지연 처리 → 발송 기한 ${kstDate(due)}`, actor: SYSTEM, at: ctx.clock.now() }).execute();
      await ctx.notifications.notify('info', `${MARKET_LABEL[o.market] ?? o.market} 발송 지연 처리`, `${o.item_name}: 발송 기한(${o.ship_by})까지 송장이 없어 기한을 ${kstDate(due)}로 미뤘습니다(페널티 방지). 공급처 출고를 확인하세요.`, { path: `/orders/${o.id}` });
    } else {
      await ctx.notifications.notify('warn', `${MARKET_LABEL[o.market] ?? o.market} 발송 지연 처리 실패`, `${o.item_name}: ${r.message}\n오늘이 발송 기한입니다. 판매자센터에서 발송 지연 처리 또는 송장 입력을 하세요(기한을 넘기면 페널티).`, { path: `/orders/${o.id}`, dedupeKey: `delay-fail-${o.id}`, dedupeMinutes: 720 });
    }
  }
  return n;
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
