import { isLive } from '../../config/env.js';
import type { AppContext } from '../../context.js';
import type { ListingItemRow, ListingRow, SourceProductRow } from '../../db/schema.js';
import { kstDate } from '../../lib/util.js';
import { detailOf } from '../catalog.js';
import { bundleOptions, guardPriceChange, priceFromMarkup } from '../pricing/pricing.js';

/**
 * 등록 상품의 판매 옵션(묶음 수량)과 가격.
 * 판매가 = 끝자리(옵션별 하한가 × (1 + listing.markup)). 마크업 하나로 모든 옵션 가격이 함께 움직인다.
 */
export interface ItemPlan {
  units: number;
  floor: number;
  salePrice: number;
  itemName: string;
}

export function itemName(title: string, units: number): string {
  return `${title} ${units}개`;
}

/** 공급처 상품 정보로 옵션별 하한가·판매가 계산 */
export async function planItems(ctx: AppContext, sp: SourceProductRow, title: string, markup: number, feeRate?: number | null): Promise<ItemPlan[]> {
  const s = await ctx.settings.get();
  const d = detailOf(sp);
  const opts = bundleOptions(s, {
    unitCost: sp.price,
    cost: sp.price,
    shipping: sp.shipping_fee,
    categoryPath: sp.category_path,
    inputVatDeductible: sp.tax_invoice,
    feeRate,
    shippingPerUnit: d?.shippingPerUnit,
    maxPerBox: d?.maxPerBox,
    stock: sp.stock,
    minResalePrice: sp.min_resale_price,
  });
  return opts.map((o) => ({ units: o.units, floor: o.floor, salePrice: priceFromMarkup(s, o.floor, markup), itemName: itemName(title, o.units) }));
}

export async function saveItems(ctx: AppContext, listingId: number, plans: ItemPlan[]): Promise<void> {
  for (const p of plans) {
    await ctx.db
      .insertInto('listing_items')
      .values({ listing_id: listingId, unit_qty: p.units, item_name: p.itemName, sale_price: p.salePrice, floor_price: p.floor, created_at: ctx.clock.now() })
      .onConflict((oc) => oc.columns(['listing_id', 'unit_qty']).doUpdateSet({ item_name: p.itemName, sale_price: p.salePrice, floor_price: p.floor }))
      .execute();
  }
  const keep = plans.map((p) => p.units);
  if (keep.length) await ctx.db.deleteFrom('listing_items').where('listing_id', '=', listingId).where('unit_qty', 'not in', keep).where('vendor_item_id', 'is', null).execute();
}

/** 옵션 목록(없으면 단일 옵션으로 간주 — 예: 기존 쿠팡 상품 연결분) */
export async function getItems(ctx: AppContext, l: ListingRow): Promise<ListingItemRow[]> {
  const rows = await ctx.db.selectFrom('listing_items').selectAll().where('listing_id', '=', l.id).orderBy('unit_qty').execute();
  if (rows.length) return rows;
  return [{ id: 0, listing_id: l.id, unit_qty: 1, item_name: l.title, vendor_item_id: l.vendor_item_id, sale_price: l.sale_price, floor_price: l.floor_price, created_at: l.created_at }];
}

export async function vendorItemIds(ctx: AppContext, l: ListingRow): Promise<string[]> {
  return (await getItems(ctx, l)).map((i) => i.vendor_item_id).filter((x): x is string => !!x);
}

/** 주문의 옵션ID → 등록 상품 + 묶음 수량 */
export async function findByVendorItem(ctx: AppContext, vendorItemId: string): Promise<{ listing: ListingRow; unitQty: number } | undefined> {
  const item = await ctx.db.selectFrom('listing_items').selectAll().where('vendor_item_id', '=', vendorItemId).orderBy('id', 'desc').executeTakeFirst();
  if (item) {
    const listing = await ctx.db.selectFrom('listings').selectAll().where('id', '=', item.listing_id).executeTakeFirst();
    if (listing) return { listing, unitQty: item.unit_qty };
  }
  const listing = await ctx.db.selectFrom('listings').selectAll().where('vendor_item_id', '=', vendorItemId).orderBy('id', 'desc').executeTakeFirst();
  return listing ? { listing, unitQty: 1 } : undefined;
}

/**
 * 마크업(과 최신 원가)으로 모든 옵션 가격을 다시 계산해 쿠팡에 반영.
 * 하한가 미만 금지·1회 변동률·하루 횟수 제한(상품 단위) 적용. 반환: 실제 바뀐 1개 옵션 가격(없으면 null)
 */
export async function reprice(ctx: AppContext, l: ListingRow, markup: number, reason: string): Promise<{ changed: boolean; price: number; floor: number }> {
  const s = await ctx.settings.get();
  const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', l.source_product_id).executeTakeFirstOrThrow();
  const plans = await planItems(ctx, sp, l.title, markup, l.fee_rate_actual);
  const items = await getItems(ctx, l);
  const today = kstDate(ctx.clock.now());
  const count = l.price_changes_date === today ? l.price_changes_count : 0;
  let changed = false;
  let base = { price: l.sale_price, floor: l.floor_price };
  for (const it of items) {
    const plan = plans.find((p) => p.units === it.unit_qty);
    if (!plan) continue;
    const g = guardPriceChange(s, { current: it.sale_price, desired: plan.salePrice, floor: plan.floor, changesToday: count });
    let newPrice = it.sale_price;
    if (g.price !== null) {
      if (it.vendor_item_id) {
        const r = await ctx.market.updatePrice(it.vendor_item_id, g.price);
        if (!r.ok) {
          ctx.log.warn({ listing: l.id, item: it.vendor_item_id, msg: r.message }, '가격 변경 실패');
          continue;
        }
        if (it.unit_qty === 1) {
          await ctx.db.insertInto('price_changes').values({ listing_id: l.id, old_price: it.sale_price, new_price: g.price, reason, dry_run: !!r.dryRun || !isLive(ctx.env, 'LIVE_PRICING'), at: ctx.clock.now() }).execute();
        }
      }
      newPrice = g.price;
      changed = true;
    }
    if (it.id) await ctx.db.updateTable('listing_items').set({ sale_price: newPrice, floor_price: plan.floor }).where('id', '=', it.id).execute();
    if (it.unit_qty === 1) base = { price: newPrice, floor: plan.floor };
  }
  await ctx.db
    .updateTable('listings')
    .set({
      sale_price: base.price,
      floor_price: base.floor,
      markup,
      ...(changed ? { price_changes_date: today, price_changes_count: count + 1, price_set_at: ctx.clock.now() } : {}),
      updated_at: ctx.clock.now(),
    })
    .where('id', '=', l.id)
    .execute();
  return { changed, ...base };
}
