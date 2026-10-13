import type { AppContext } from '../../context.js';
import type { ListingRow } from '../../db/schema.js';

/** 상품 판매중지(쿠팡) + 상태 기록. 이미 중지면 무시 */
export async function pauseListing(ctx: AppContext, listing: ListingRow, reason: string, final = false): Promise<boolean> {
  if (listing.status === 'paused' || listing.status === 'stopped') {
    if (final && listing.status !== 'stopped') {
      await ctx.db.updateTable('listings').set({ status: 'stopped', status_reason: reason, updated_at: ctx.clock.now() }).where('id', '=', listing.id).execute();
    }
    return false;
  }
  if (listing.vendor_item_id) {
    const r = await ctx.market.stopSale(listing.vendor_item_id);
    if (!r.ok) {
      ctx.log.warn({ listing: listing.id, msg: r.message }, '판매중지 실패');
      return false;
    }
  }
  await ctx.db
    .updateTable('listings')
    .set({ status: final ? 'stopped' : 'paused', status_reason: reason, updated_at: ctx.clock.now() })
    .where('id', '=', listing.id)
    .execute();
  return true;
}

export async function resumeListing(ctx: AppContext, listing: ListingRow): Promise<boolean> {
  if (listing.status !== 'paused' || !listing.vendor_item_id) return false;
  const r = await ctx.market.resumeSale(listing.vendor_item_id);
  if (!r.ok) return false;
  await ctx.db.updateTable('listings').set({ status: 'active', status_reason: null, updated_at: ctx.clock.now() }).where('id', '=', listing.id).execute();
  return true;
}

export async function findListingByVendorItem(ctx: AppContext, vendorItemId: string): Promise<ListingRow | undefined> {
  return ctx.db.selectFrom('listings').selectAll().where('vendor_item_id', '=', vendorItemId).orderBy('id', 'desc').executeTakeFirst();
}
