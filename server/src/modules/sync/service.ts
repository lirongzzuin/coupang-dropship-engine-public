import type { AppContext } from '../../context.js';
import type { ListingRow } from '../../db/schema.js';
import { addDays, errMessage, kstDate } from '../../lib/util.js';
import { upsertSourceProduct } from '../catalog.js';
import { pauseListing, resumeListing } from '../listing/control.js';
import { computeProfit, guardPriceChange, targetPrice } from '../pricing/pricing.js';

/** 가격 변경(하루 횟수 카운트·이력 기록 포함) */
export async function changePrice(ctx: AppContext, l: ListingRow, desired: number, floor: number, reason: string): Promise<number | null> {
  const s = await ctx.settings.get();
  const today = kstDate(ctx.clock.now());
  const count = l.price_changes_date === today ? l.price_changes_count : 0;
  const g = guardPriceChange(s, { current: l.sale_price, desired, floor, changesToday: count });
  if (g.price === null) return null;
  if (l.vendor_item_id) {
    const r = await ctx.market.updatePrice(l.vendor_item_id, g.price);
    if (!r.ok) {
      ctx.log.warn({ listing: l.id, msg: r.message }, '가격 변경 실패');
      return null;
    }
    await ctx.db.insertInto('price_changes').values({ listing_id: l.id, old_price: l.sale_price, new_price: g.price, reason, dry_run: !!r.dryRun, at: ctx.clock.now() }).execute();
  }
  await ctx.db
    .updateTable('listings')
    .set({ sale_price: g.price, floor_price: floor, price_changes_date: today, price_changes_count: count + 1, updated_at: ctx.clock.now() })
    .where('id', '=', l.id)
    .execute();
  return g.price;
}

/**
 * 운영 중 상품의 공급가·재고 동기화.
 * - 품절/단종 → 판매중지(paused), 재입고 → 재개
 * - 공급가 상승으로 하한가 > 판매가 → 인상(가드 범위 내). 인상 후에도 손실이면 판매중지
 * - 공급가 하락 → autoLowerPrice 일 때만 인하
 * - 재고 수량 반영
 */
export async function syncListings(ctx: AppContext): Promise<{ checked: number; paused: number; resumed: number; repriced: number; errors: number }> {
  const s = await ctx.settings.get();
  const stats = { checked: 0, paused: 0, resumed: 0, repriced: 0, errors: 0 };
  if (s.killSwitch) return stats;
  const listings = await ctx.db.selectFrom('listings').selectAll().where('status', 'in', ['active', 'paused']).execute();
  for (const l of listings) {
    if (l.status === 'paused' && l.status_reason && !['공급처 품절', '마진 역전', '공급가 상승'].includes(l.status_reason)) continue; // 수동 중지는 건드리지 않음
    const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', l.source_product_id).executeTakeFirstOrThrow();
    const src = ctx.sources.get(sp.source);
    if (!src?.capabilities.detail) continue;
    stats.checked++;
    try {
      const d = await src.getProduct(sp.source_item_id, { title: sp.title });
      if (!d) continue;
      await upsertSourceProduct(ctx, sp.source, d);
      const available = d.status === 'active' && (d.stock === null || d.stock > 0);
      if (!available) {
        if (await pauseListing(ctx, l, '공급처 품절')) stats.paused++;
        continue;
      }
      const tp = targetPrice(s, { cost: d.price, shipping: d.shippingFee, categoryPath: d.categoryPath, inputVatDeductible: d.taxInvoice, minResalePrice: d.minResalePrice });
      if (!tp.feasible) {
        if (await pauseListing(ctx, l, '마진 역전')) stats.paused++;
        continue;
      }
      let current = l;
      if (tp.floor > l.sale_price || (s.pricing.autoLowerPrice && tp.floor < l.sale_price)) {
        const np = await changePrice(ctx, l, tp.floor, tp.floor, tp.floor > l.sale_price ? '공급가 상승' : '공급가 하락');
        if (np !== null) {
          stats.repriced++;
          current = { ...l, sale_price: np, floor_price: tp.floor };
        }
      } else if (tp.floor !== l.floor_price) {
        await ctx.db.updateTable('listings').set({ floor_price: tp.floor }).where('id', '=', l.id).execute();
      }
      const profit = computeProfit(s, current.sale_price, { cost: d.price, shipping: d.shippingFee, categoryPath: d.categoryPath, inputVatDeductible: d.taxInvoice }).profit;
      if (profit < 0) {
        if (await pauseListing(ctx, current, '마진 역전')) stats.paused++;
        continue;
      }
      if (current.status === 'paused' && (await resumeListing(ctx, current))) stats.resumed++;
      if (current.vendor_item_id && d.stock !== null) await ctx.market.updateQuantity(current.vendor_item_id, Math.min(d.stock, 999));
    } catch (e) {
      stats.errors++;
      ctx.log.warn({ listing: l.id, err: errMessage(e) }, '동기화 실패');
    }
  }
  if (stats.paused) await ctx.notifications.notify('warn', `상품 ${stats.paused}개 자동 판매중지`, '품절 또는 마진 역전. 재입고/가격 회복 시 자동 재개됩니다.', { path: '/listings', dedupeKey: `sync-paused-${kstDate(ctx.clock.now())}`, dedupeMinutes: 180 });
  return stats;
}

/** 판매 부진 상품: N일 판매 0 → 하한가로 1회 인하 → 그래도 0이면 판매종료 */
export async function reviewSlowListings(ctx: AppContext): Promise<{ lowered: number; stopped: number }> {
  const s = await ctx.settings.get();
  const out = { lowered: 0, stopped: 0 };
  if (s.killSwitch) return out;
  const cutoff = addDays(ctx.clock.now(), -s.listing.zeroSaleDays);
  const rows = await ctx.db.selectFrom('listings').selectAll().where('status', '=', 'active').where('listed_at', '<', cutoff).execute();
  for (const l of rows) {
    const since = l.zero_sale_adjusted ? new Date(l.updated_at) : new Date(l.listed_at!);
    if (since > cutoff) continue;
    const sold = await ctx.db.selectFrom('orders').select((eb) => eb.fn.countAll<number>().as('n')).where('listing_id', '=', l.id).where('ordered_at', '>=', since).executeTakeFirst();
    if (Number(sold?.n ?? 0) > 0) continue;
    if (!l.zero_sale_adjusted && l.sale_price > l.floor_price) {
      await changePrice(ctx, l, l.floor_price, l.floor_price, '판매 부진 인하');
      await ctx.db.updateTable('listings').set({ zero_sale_adjusted: true, updated_at: ctx.clock.now() }).where('id', '=', l.id).execute();
      out.lowered++;
    } else {
      await pauseListing(ctx, l, `판매 부진(${s.listing.zeroSaleDays}일 0건)`, true);
      out.stopped++;
    }
  }
  if (out.stopped) await ctx.notifications.notify('info', `판매 부진 상품 ${out.stopped}개 종료`, '다음 선정 주기에 새 후보로 교체됩니다.', { path: '/listings' });
  return out;
}
