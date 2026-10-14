import type { AppContext } from '../../context.js';
import type { ListingItemRow, ListingRow } from '../../db/schema.js';
import { findByVendorItem, getItems, vendorItemIds } from './items.js';

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
  /** Wing에서 상품을 삭제함 → 판매종료로 정리(관리 화면 기본 목록에서 숨김, 다시 등록 안 함) */
  deleted: '쿠팡에서 삭제됨',
  /** 공급처 옵션이 여러 개인데 어떤 옵션을 파는지 정해지지 않은 채 올라간 상품(이전 버전) → [옵션 지정해 다시 등록] */
  optionUnset: '옵션 미지정',
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
  const all = await getItems(ctx, listing);
  if (listing.status !== 'paused' || !all.some((i) => i.vendor_item_id)) return false;
  // 옵션 단위로 멈춘 옵션(그 옵션만 품절 등)은 다시 켜지 않음
  const vids = all.filter((i) => i.item_status !== 'paused').map((i) => i.vendor_item_id).filter((x): x is string => !!x);
  for (const vid of vids) {
    const r = await ctx.market.resumeSale(vid);
    if (!r.ok) return false;
  }
  await ctx.db.updateTable('listings').set({ status: 'active', status_reason: null, paused_at: null, updated_at: ctx.clock.now() }).where('id', '=', listing.id).execute();
  return true;
}

/**
 * 옵션 하나만 판매중지(여러 공급처 옵션을 함께 파는 상품에서 그 옵션만 품절 등). 상품 전체는 그대로.
 * 반환: 실제로 멈췄는지
 */
export async function pauseItem(ctx: AppContext, item: ListingItemRow, reason: string): Promise<boolean> {
  if (item.item_status === 'paused') {
    if (item.item_reason !== reason && item.id) await ctx.db.updateTable('listing_items').set({ item_reason: reason.slice(0, 300) }).where('id', '=', item.id).execute();
    return false;
  }
  if (item.vendor_item_id) {
    const r = await ctx.market.stopSale(item.vendor_item_id);
    if (!r.ok) {
      ctx.log.warn({ item: item.vendor_item_id, msg: r.message }, '옵션 판매중지 실패');
      return false;
    }
  }
  if (item.id) await ctx.db.updateTable('listing_items').set({ item_status: 'paused', item_reason: reason.slice(0, 300) }).where('id', '=', item.id).execute();
  return true;
}

/** 옵션 판매 재개(상품이 판매중일 때만 쿠팡에 반영) */
export async function resumeItem(ctx: AppContext, item: ListingItemRow, listingActive: boolean): Promise<boolean> {
  if (item.item_status !== 'paused') return false;
  if (listingActive && item.vendor_item_id) {
    const r = await ctx.market.resumeSale(item.vendor_item_id);
    if (!r.ok) return false;
  }
  if (item.id) await ctx.db.updateTable('listing_items').set({ item_status: 'active', item_reason: null }).where('id', '=', item.id).execute();
  return true;
}

export async function findListingByVendorItem(ctx: AppContext, vendorItemId: string): Promise<ListingRow | undefined> {
  return (await findByVendorItem(ctx, vendorItemId))?.listing;
}
