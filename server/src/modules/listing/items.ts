import type { Settings } from '../../config/settings.js';
import type { AppContext } from '../../context.js';
import type { ListingItemRow, ListingRow, SourceProductRow } from '../../db/schema.js';
import { kstDate } from '../../lib/util.js';
import type { SourceOption, SourceProductDetail } from '../../ports/source.js';
import { detailOf } from '../catalog.js';
import { bundleOptions, guardPriceChange, priceFromMarkup } from '../pricing/pricing.js';

/**
 * 등록 상품의 쿠팡 옵션 = 공급처 옵션(색상·사이즈 등, 여러 개면 함께 판매) × 묶음 수량.
 * 판매가 = 끝자리(옵션별 하한가 × (1 + listing.markup)). 하한가는 그 공급처 옵션의 실제 원가로 계산하고,
 * 마크업 하나로 모든 옵션 가격이 함께 움직인다.
 * option = '' 이면 상품의 고정 옵션 하나(listings.source_option)를 파는 기존 방식.
 */
export interface ItemPlan {
  units: number;
  /** 공급처 옵션('' = 상품 고정 옵션) */
  option: string;
  floor: number;
  salePrice: number;
  itemName: string;
  /** 이 공급처 옵션 재고(null = 모름) */
  stock: number | null;
}

export function itemName(title: string, units: number, option = ''): string {
  return `${title}${option ? ` ${option}` : ''} ${units}개`;
}

/**
 * 함께 판매할 공급처 옵션들(싼 순, 최대 maxVariants). 재고 있고 이름 있는 옵션만.
 * 옵션이 하나뿐이거나 여러 옵션 판매가 꺼져 있으면 빈 배열(= 고정 옵션 하나 방식)
 */
export function sellableVariants(s: Settings, d: SourceProductDetail | null | undefined): SourceOption[] {
  if (!s.listing.multiVariant || d?.optionIssue) return [];
  const opts = (d?.options ?? []).filter((o) => o.name && (o.stock === null || o.stock > 0));
  if (opts.length <= 1) return [];
  return [...opts].sort((a, b) => a.price - b.price || (b.stock ?? 0) - (a.stock ?? 0)).slice(0, s.listing.maxVariants);
}

/** 이 상품에서 판매 중인 공급처 옵션들(쿠팡 옵션에 기록된 것) — 없으면 고정 옵션 하나 방식 */
export async function listingVariants(ctx: AppContext, l: ListingRow): Promise<string[]> {
  const rows = await ctx.db.selectFrom('listing_items').select('source_option').distinct().where('listing_id', '=', l.id).where('source_option', '!=', '').execute();
  return rows.map((r) => r.source_option);
}

/**
 * 공급처 상품 정보로 옵션별 하한가·판매가 계산.
 * variants 가 있으면 그 공급처 옵션마다(옵션 원가·재고 기준) 묶음 수량별로, 없으면 상품 원가(고정 옵션)로.
 * 쿠팡 옵션 수가 maxItems 를 넘으면 큰 묶음부터 뺀다(공급처 옵션 1개짜리는 항상 유지).
 */
export async function planItems(ctx: AppContext, sp: SourceProductRow, title: string, markup: number, feeRate?: number | null, variants: string[] = []): Promise<ItemPlan[]> {
  const s = await ctx.settings.get();
  const d = detailOf(sp);
  const base = {
    shipping: sp.shipping_fee,
    categoryPath: sp.category_path,
    inputVatDeductible: sp.tax_invoice,
    feeRate,
    shippingPerUnit: d?.shippingPerUnit,
    maxPerBox: d?.maxPerBox,
    minResalePrice: sp.min_resale_price,
  };
  if (!variants.length) {
    return bundleOptions(s, { ...base, unitCost: sp.price, cost: sp.price, stock: sp.stock })
      .map((o) => ({ units: o.units, option: '', floor: o.floor, salePrice: priceFromMarkup(s, o.floor, markup), itemName: itemName(title, o.units), stock: sp.stock }));
  }
  let plans: ItemPlan[] = [];
  for (const name of variants) {
    const o = (d?.options ?? []).find((x) => x.name === name);
    if (!o) continue; // 공급처에서 없어진 옵션 — 이번 계산에서 빠짐(동기화가 그 옵션 판매중지)
    for (const b of bundleOptions(s, { ...base, unitCost: o.price, cost: o.price, stock: o.stock })) {
      plans.push({ units: b.units, option: o.name, floor: b.floor, salePrice: priceFromMarkup(s, b.floor, markup), itemName: itemName(title, b.units, o.name), stock: o.stock });
    }
  }
  // 옵션 수 상한: 큰 묶음부터 뺌
  for (const u of [...new Set(plans.map((p) => p.units))].sort((a, b) => b - a)) {
    if (plans.length <= s.listing.maxItems || u === 1) break;
    plans = plans.filter((p) => p.units !== u);
  }
  return plans.slice(0, s.listing.maxItems);
}

export async function saveItems(ctx: AppContext, listingId: number, plans: ItemPlan[]): Promise<void> {
  for (const p of plans) {
    await ctx.db
      .insertInto('listing_items')
      .values({ listing_id: listingId, unit_qty: p.units, source_option: p.option, item_name: p.itemName, sale_price: p.salePrice, floor_price: p.floor, created_at: ctx.clock.now() })
      .onConflict((oc) => oc.columns(['listing_id', 'unit_qty', 'source_option']).doUpdateSet({ item_name: p.itemName, sale_price: p.salePrice, floor_price: p.floor }))
      .execute();
  }
  // 계획에서 빠진 옵션(아직 쿠팡에 없는 것만) 정리
  const keep = new Set(plans.map((p) => `${p.units}|${p.option}`));
  const rows = await ctx.db.selectFrom('listing_items').select(['id', 'unit_qty', 'source_option']).where('listing_id', '=', listingId).where('vendor_item_id', 'is', null).execute();
  const drop = rows.filter((r) => !keep.has(`${r.unit_qty}|${r.source_option}`)).map((r) => r.id);
  if (plans.length && drop.length) await ctx.db.deleteFrom('listing_items').where('id', 'in', drop).execute();
}

/** 옵션 목록(없으면 단일 옵션으로 간주 — 예: 기존 쿠팡 상품 연결분) */
export async function getItems(ctx: AppContext, l: ListingRow): Promise<ListingItemRow[]> {
  const rows = await ctx.db.selectFrom('listing_items').selectAll().where('listing_id', '=', l.id).orderBy('source_option').orderBy('unit_qty').execute();
  if (rows.length) return rows;
  return [{ id: 0, listing_id: l.id, unit_qty: 1, item_name: l.title, vendor_item_id: l.vendor_item_id, sale_price: l.sale_price, floor_price: l.floor_price, created_at: l.created_at, source_option: '', item_status: 'active', item_reason: null }];
}

/** 대표 옵션(가격 비교·목록 표시 기준): 상품 고정 옵션의 1개 묶음, 없으면 첫 1개 묶음 */
export function baseItemOf(items: ListingItemRow[], l: Pick<ListingRow, 'source_option'>): ListingItemRow | undefined {
  const ones = items.filter((i) => i.unit_qty === 1);
  return ones.find((i) => !i.source_option || i.source_option === l.source_option) ?? ones[0] ?? items[0];
}

/** 이 쿠팡 옵션이 발주할 공급처 옵션 */
export function itemSourceOption(item: Pick<ListingItemRow, 'source_option'> | undefined, l: Pick<ListingRow, 'source_option'>): string | null {
  return item?.source_option || l.source_option || null;
}

export async function vendorItemIds(ctx: AppContext, l: ListingRow): Promise<string[]> {
  return (await getItems(ctx, l)).map((i) => i.vendor_item_id).filter((x): x is string => !!x);
}

/** 주문의 옵션ID → 등록 상품 + 묶음 수량 + 발주할 공급처 옵션 */
export async function findByVendorItem(ctx: AppContext, vendorItemId: string): Promise<{ listing: ListingRow; unitQty: number; option: string | null } | undefined> {
  const item = await ctx.db.selectFrom('listing_items').selectAll().where('vendor_item_id', '=', vendorItemId).orderBy('id', 'desc').executeTakeFirst();
  if (item) {
    const listing = await ctx.db.selectFrom('listings').selectAll().where('id', '=', item.listing_id).executeTakeFirst();
    if (listing) return { listing, unitQty: item.unit_qty, option: itemSourceOption(item, listing) };
  }
  const listing = await ctx.db.selectFrom('listings').selectAll().where('vendor_item_id', '=', vendorItemId).orderBy('id', 'desc').executeTakeFirst();
  return listing ? { listing, unitQty: 1, option: listing.source_option } : undefined;
}

/**
 * 마크업(과 최신 원가)으로 모든 옵션 가격을 다시 계산해 쿠팡에 반영.
 * 하한가 미만 금지·1회 변동률·하루 횟수 제한(상품 단위) 적용. 반환: 대표 옵션 가격
 */
export async function reprice(ctx: AppContext, l: ListingRow, markup: number, reason: string): Promise<{ changed: boolean; price: number; floor: number }> {
  const s = await ctx.settings.get();
  const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', l.source_product_id).executeTakeFirstOrThrow();
  const plans = await planItems(ctx, sp, l.title, markup, l.fee_rate_actual, await listingVariants(ctx, l));
  const items = await getItems(ctx, l);
  const baseItem = baseItemOf(items, l);
  const today = kstDate(ctx.clock.now());
  const count = l.price_changes_date === today ? l.price_changes_count : 0;
  let changed = false;
  let base = { price: l.sale_price, floor: l.floor_price };
  for (const it of items) {
    const plan = plans.find((p) => p.units === it.unit_qty && p.option === (it.source_option ?? ''));
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
        if (it === baseItem) {
          await ctx.db.insertInto('price_changes').values({ listing_id: l.id, old_price: it.sale_price, new_price: g.price, reason, dry_run: !!r.dryRun, at: ctx.clock.now() }).execute();
        }
      }
      newPrice = g.price;
      changed = true;
    }
    if (it.id) await ctx.db.updateTable('listing_items').set({ sale_price: newPrice, floor_price: plan.floor }).where('id', '=', it.id).execute();
    if (it === baseItem) base = { price: newPrice, floor: plan.floor };
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
