import type { AppContext } from '../../context.js';
import { addDays, kstDate } from '../../lib/util.js';
import { transition } from '../orders/service.js';
import type { OrderStatus } from '../orders/stateMachine.js';

/**
 * 정산 대사: 쿠팡 매출내역(매출인식일 기준, 최대 31일, 전일까지) → 주문 매칭 → 실제 손익 확정.
 * 손익 = 정산금액 + 배송비 정산 − 공급처 결제금액(상품+배송비). (현금 기준, 부가세 신고 전)
 */
export async function reconcile(ctx: AppContext): Promise<{ imported: number; settled: number; refunds: number }> {
  const now = ctx.clock.now();
  const to = kstDate(addDays(now, -1));
  const from = kstDate(addDays(now, -31));
  const lines = await ctx.market.listRevenue(from, to);
  let imported = 0, settled = 0, refunds = 0;
  for (const r of lines) {
    const res = await ctx.db
      .insertInto('settlements')
      .values({
        market_order_id: r.marketOrderId,
        vendor_item_id: r.vendorItemId,
        sale_type: r.saleType,
        sale_amount: r.saleAmount,
        service_fee: r.serviceFee,
        service_fee_vat: r.serviceFeeVat,
        settlement_amount: r.settlementAmount,
        delivery_settlement: r.deliverySettlement,
        recognized_at: r.recognizedAt,
        raw: JSON.stringify(r.raw ?? null),
        imported_at: now,
      })
      .onConflict((oc) => oc.columns(['market_order_id', 'vendor_item_id', 'sale_type', 'recognized_at']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (res) imported++;
  }
  // 실제 수수료율 학습: 판매 정산의 서비스이용료/매출금액 → 상품별 지수평균(가격 계산에 사용)
  for (const r of lines) {
    if (r.saleType !== 'SALE' || r.saleAmount <= 0) continue;
    const o = await ctx.db.selectFrom('orders').select(['listing_id']).where('market_order_id', '=', r.marketOrderId).where('vendor_item_id', '=', r.vendorItemId).executeTakeFirst();
    if (!o?.listing_id) continue;
    const ratio = r.serviceFee / r.saleAmount;
    if (!(ratio > 0 && ratio < 0.5)) continue;
    const l = await ctx.db.selectFrom('listings').select(['fee_rate_actual']).where('id', '=', o.listing_id).executeTakeFirst();
    const next = l?.fee_rate_actual ? l.fee_rate_actual * 0.7 + ratio * 0.3 : ratio;
    await ctx.db.updateTable('listings').set({ fee_rate_actual: Math.round(next * 10000) / 10000 }).where('id', '=', o.listing_id).execute();
  }
  // 반품완료(클레임 추적으로 먼저 끝난 주문)도 환불 정산이 들어오면 손익 기록
  const candidates = await ctx.db.selectFrom('orders').selectAll()
    .where((eb) => eb.or([eb('status', 'in', ['DELIVERED', 'TRACKING_UPLOADED', 'IN_TRANSIT', 'RETURN_REQUESTED']), eb.and([eb('status', '=', 'RETURNED'), eb('settled_at', 'is', null)])]))
    .execute();
  for (const o of candidates) {
    const rows = await ctx.db.selectFrom('settlements').selectAll().where('market_order_id', '=', o.market_order_id).where('vendor_item_id', '=', o.vendor_item_id).execute();
    if (!rows.length) continue;
    const total = rows.reduce((a, x) => a + (x.sale_type === 'REFUND' ? -1 : 1) * (x.settlement_amount + x.delivery_settlement), 0);
    const hasRefund = rows.some((x) => x.sale_type === 'REFUND');
    const profit = total - (o.purchase_cost ?? o.expected_cost ?? 0) - (o.purchase_shipping ?? 0) - (o.extra_cost ?? 0);
    const patch = { settlement_amount: total, profit, settled_at: now };
    if (hasRefund) {
      refunds++;
      const st = o.status as OrderStatus;
      if (st === 'RETURN_REQUESTED') await transition(ctx, o, 'RETURNED', '환불 정산 확인', 'system', patch);
      else await ctx.db.updateTable('orders').set(patch).where('id', '=', o.id).execute();
      continue;
    }
    if (o.status === 'DELIVERED' || o.status === 'IN_TRANSIT' || o.status === 'TRACKING_UPLOADED') {
      if (o.status !== 'DELIVERED') await ctx.db.updateTable('orders').set({ status: 'DELIVERED', delivered_at: o.delivered_at ?? now }).where('id', '=', o.id).execute();
      await transition(ctx, { ...o, status: 'DELIVERED' }, 'SETTLED', '정산 확인', 'system', patch);
      settled++;
    }
  }
  return { imported, settled, refunds };
}

/** 월별 손익 CSV (KST 기준 주문월) */
export async function monthlyCsv(ctx: AppContext, month: string): Promise<string> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('월 형식은 YYYY-MM');
  const start = new Date(`${month}-01T00:00:00+09:00`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const rows = await ctx.db
    .selectFrom('orders')
    .leftJoin('source_products', 'source_products.id', 'orders.source_product_id')
    .select([
      'orders.id', 'orders.market_order_id', 'orders.ordered_at', 'orders.item_name', 'orders.qty', 'orders.sale_amount', 'orders.status',
      'orders.purchase_cost', 'orders.purchase_shipping', 'orders.expected_profit', 'orders.settlement_amount', 'orders.profit',
      'orders.source_order_id', 'source_products.source as source',
    ])
    .where('orders.ordered_at', '>=', start)
    .where('orders.ordered_at', '<', end)
    .orderBy('orders.ordered_at')
    .execute();
  const head = ['주문ID', '쿠팡주문번호', '주문일(KST)', '상품명', '수량', '판매금액', '상태', '공급처', '공급처주문번호', '매입금액', '매입배송비', '예상이익', '정산금액', '확정이익'];
  const esc = (v: unknown) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const body = rows.map((r) => [r.id, r.market_order_id, kstDate(new Date(r.ordered_at)), r.item_name, r.qty, r.sale_amount, r.status, r.source, r.source_order_id, r.purchase_cost, r.purchase_shipping, r.expected_profit, r.settlement_amount, r.profit].map(esc).join(','));
  const sum = (k: 'sale_amount' | 'profit' | 'expected_profit') => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  body.push(['합계', '', '', '', '', sum('sale_amount'), '', '', '', '', '', sum('expected_profit'), '', sum('profit')].map(esc).join(','));
  return `﻿${head.join(',')}\n${body.join('\n')}\n`;
}

/** 상품별 수익(최근 N일): 주문수·매출·예상/확정 이익 — 잘 버는 상품과 못 버는 상품 */
export async function listingProfit(ctx: AppContext, days = 30) {
  const since = addDays(ctx.clock.now(), -days);
  const rows = await ctx.db
    .selectFrom('orders')
    .innerJoin('listings', 'listings.id', 'orders.listing_id')
    .select((eb) => [
      'listings.id as listingId', 'listings.title as title', 'listings.sale_price as salePrice', 'listings.markup as markup', 'listings.status as status',
      eb.fn.countAll<number>().as('orders'),
      eb.fn.coalesce(eb.fn.sum<number>('orders.sale_amount'), eb.lit(0)).as('revenue'),
      eb.fn.coalesce(eb.fn.sum<number>('orders.expected_profit'), eb.lit(0)).as('expectedProfit'),
      eb.fn.coalesce(eb.fn.sum<number>('orders.profit'), eb.lit(0)).as('settledProfit'),
    ])
    .where('orders.ordered_at', '>=', since)
    .where('orders.status', 'not in', ['CANCELLED'])
    .groupBy(['listings.id', 'listings.title', 'listings.sale_price', 'listings.markup', 'listings.status'])
    .execute();
  return rows
    .map((r) => ({ ...r, orders: Number(r.orders), revenue: Number(r.revenue), expectedProfit: Number(r.expectedProfit), settledProfit: Number(r.settledProfit) }))
    .sort((a, b) => b.expectedProfit - a.expectedProfit);
}
