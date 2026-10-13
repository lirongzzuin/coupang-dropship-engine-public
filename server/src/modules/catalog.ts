import type { AppContext } from '../context.js';
import type { SourceProductRow } from '../db/schema.js';
import type { SourceProductDetail } from '../ports/source.js';

/** 공급처 상품 스냅샷 저장(+가격·재고 이력) */
export async function upsertSourceProduct(ctx: AppContext, source: string, d: SourceProductDetail): Promise<SourceProductRow> {
  const now = ctx.clock.now();
  const values = {
    source,
    source_item_id: d.sourceItemId,
    title: d.title,
    url: d.url,
    image_url: d.imageUrl ?? d.images[0] ?? null,
    category_path: d.categoryPath ?? null,
    price: Math.round(d.price),
    shipping_fee: Math.round(d.shippingFee),
    stock: d.stock,
    min_resale_price: d.minResalePrice ?? null,
    image_reuse_allowed: d.imageReuseAllowed,
    tax_invoice: d.taxInvoice,
    prep_days: d.prepDays ?? null,
    status: d.status,
    detail: JSON.stringify(d),
    fetched_at: now,
  };
  const prev = await ctx.db.selectFrom('source_products').selectAll().where('source', '=', source).where('source_item_id', '=', d.sourceItemId).executeTakeFirst();
  const row = await ctx.db
    .insertInto('source_products')
    .values(values)
    .onConflict((oc) => oc.columns(['source', 'source_item_id']).doUpdateSet({ ...values }))
    .returningAll()
    .executeTakeFirstOrThrow();
  if (!prev || prev.price !== row.price || prev.shipping_fee !== row.shipping_fee || prev.stock !== row.stock || prev.status !== row.status) {
    await ctx.db
      .insertInto('source_price_history')
      .values({ source_product_id: row.id, price: row.price, shipping_fee: row.shipping_fee, stock: row.stock, status: row.status, at: now })
      .execute();
  }
  return row;
}

export function detailOf(row: SourceProductRow): SourceProductDetail | null {
  return (row.detail as SourceProductDetail | null) ?? null;
}
