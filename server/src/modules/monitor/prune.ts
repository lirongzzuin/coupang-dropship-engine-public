import { isLive } from '../../config/env.js';
import type { AppContext } from '../../context.js';
import type { ListingRow } from '../../db/schema.js';

/**
 * 우선순위 교체: 운영 상품 수가 상한일 때, 새 후보가 기존 저성과 상품보다 확실히 나으면 자리를 바꾼다.
 * - 대상: 등록 후 minAgeDays 넘게 운영해 실적이 쌓인 판매중 상품(출시·가격 조정 기간 보호)
 * - 실적: 최근 windowDays 실제 주문의 예상이익 합(취소 제외)을 월 단위로 환산
 * - 조건: 새 후보 기대 월이익 ≥ max(replaceMinGainKrw, 기존 실적 × replaceAdvantage), 기존 실적 < protectMonthlyProfitKrw
 * - 가장 실적이 낮은(같으면 오래된) 상품 하나를 고른다
 */
export interface Replaceable {
  listing: ListingRow;
  monthlyProfit: number;
  orders: number;
}

/** 상한 계산과 같은 기준의 운영 상품 수(실등록 모드에선 모의 등록 제외) */
export async function activeListingCount(ctx: AppContext): Promise<number> {
  // 상한은 쿠팡 상품 기준(스마트스토어는 쿠팡 상품을 따라 올리며 naver.maxListings 로 따로 제한)
  let q = ctx.db.selectFrom('listings').select((eb) => eb.fn.countAll<number>().as('n')).where('market', '=', 'coupang').where('status', 'in', ['active', 'pending_approval']);
  if (isLive(ctx.env, 'LIVE_LISTING')) q = q.where('dry_run', '=', false);
  return Number((await q.executeTakeFirst())?.n ?? 0);
}

export async function pickReplaceable(ctx: AppContext, candidateMonthlyProfit: number, exclude: number[] = []): Promise<Replaceable | null> {
  const s = await ctx.settings.get();
  const p = s.prune;
  if (!p.enabled || candidateMonthlyProfit < p.replaceMinGainKrw) return null;
  const now = ctx.clock.now();
  const minListed = new Date(now.getTime() - p.minAgeDays * 86400_000);
  let q = ctx.db.selectFrom('listings').selectAll().where('market', '=', 'coupang').where('status', '=', 'active').where('listed_at', '<', minListed);
  if (isLive(ctx.env, 'LIVE_LISTING')) q = q.where('dry_run', '=', false);
  const rows = (await q.execute()).filter((l) => !exclude.includes(l.id));
  if (!rows.length) return null;
  const since = new Date(now.getTime() - p.windowDays * 86400_000);
  const agg = await ctx.db.selectFrom('orders')
    .select(['listing_id', (eb) => eb.fn.countAll<number>().as('n'), (eb) => eb.fn.coalesce(eb.fn.sum<number>('expected_profit'), eb.lit(0)).as('profit')])
    .where('listing_id', 'in', rows.map((r) => r.id)).where('ordered_at', '>=', since).where('status', '!=', 'CANCELLED')
    .groupBy('listing_id').execute();
  const perf = new Map(agg.map((a) => [a.listing_id, { orders: Number(a.n), profit: Number(a.profit) }]));
  const scale = 30 / p.windowDays;
  const ranked = rows
    .map((l) => ({ listing: l, orders: perf.get(l.id)?.orders ?? 0, monthlyProfit: Math.round((perf.get(l.id)?.profit ?? 0) * scale) }))
    .filter((x) => x.monthlyProfit < p.protectMonthlyProfitKrw && candidateMonthlyProfit >= Math.max(p.replaceMinGainKrw, x.monthlyProfit * p.replaceAdvantage))
    .sort((a, b) => a.monthlyProfit - b.monthlyProfit || new Date(a.listing.listed_at!).getTime() - new Date(b.listing.listed_at!).getTime());
  return ranked[0] ?? null;
}
