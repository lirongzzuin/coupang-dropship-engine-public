import type { AppContext } from '../../context.js';
import type { ListingRow } from '../../db/schema.js';
import { findByVendorItem, vendorItemIds } from './items.js';

/**
 * 자동 판매중지 사유. 사유 문자열은 "접두: 상세" 형식이고 접두로 분류한다.
 * - 공급처 사유: 동기화가 공급처 회복(재입고·가격 회복 등)을 확인하면 자동 재개
 * - 주문 불가: 주문 가능 점검(공급처 주문 시뮬레이션)이 다시 통과하면 자동 재개
 * - 그 외(관리자 중지·안전장치·Wing에서 중지·판매 부진)는 자동 재개하지 않음
 */
export const PAUSE = {
  soldout: '공급처 품절',
  lowStock: '공급처 재고 부족',
  notSellable: '공급처 판매 불가',
  margin: '마진 역전',
  costUp: '공급가 상승',
  minResale: '최저판매준수가 미달',
  unverifiable: '공급처 확인 불가',
  unorderable: '주문 불가',
  wing: '쿠팡에서 판매중지됨',
} as const;

const SUPPLY = [PAUSE.soldout, PAUSE.lowStock, PAUSE.notSellable, PAUSE.margin, PAUSE.costUp, PAUSE.minResale, PAUSE.unverifiable];

export function pauseKind(reason: string | null): 'supply' | 'order' | 'other' {
  if (!reason) return 'other';
  if (SUPPLY.some((p) => reason.startsWith(p))) return 'supply';
  if (reason.startsWith(PAUSE.unorderable)) return 'order';
  return 'other';
}

/** 상품 판매중지(쿠팡) + 상태 기록. 이미 중지면 무시 */
export async function pauseListing(ctx: AppContext, listing: ListingRow, reason: string, final = false): Promise<boolean> {
  if (listing.status === 'paused' || listing.status === 'stopped') {
    if (final && listing.status !== 'stopped') {
      await ctx.db.updateTable('listings').set({ status: 'stopped', status_reason: reason, updated_at: ctx.clock.now() }).where('id', '=', listing.id).execute();
    }
    return false;
  }
  for (const vid of await vendorItemIds(ctx, listing)) {
    const r = await ctx.market.stopSale(vid);
    if (!r.ok) {
      ctx.log.warn({ listing: listing.id, msg: r.message }, '판매중지 실패');
      return false;
    }
  }
  const now = ctx.clock.now();
  await ctx.db
    .updateTable('listings')
    .set({ status: final ? 'stopped' : 'paused', status_reason: reason.slice(0, 300), paused_at: now, updated_at: now })
    .where('id', '=', listing.id)
    .execute();
  return true;
}

export async function resumeListing(ctx: AppContext, listing: ListingRow): Promise<boolean> {
  const vids = await vendorItemIds(ctx, listing);
  if (listing.status !== 'paused' || !vids.length) return false;
  for (const vid of vids) {
    const r = await ctx.market.resumeSale(vid);
    if (!r.ok) return false;
  }
  await ctx.db.updateTable('listings').set({ status: 'active', status_reason: null, paused_at: null, updated_at: ctx.clock.now() }).where('id', '=', listing.id).execute();
  return true;
}

export async function findListingByVendorItem(ctx: AppContext, vendorItemId: string): Promise<ListingRow | undefined> {
  return (await findByVendorItem(ctx, vendorItemId))?.listing;
}
