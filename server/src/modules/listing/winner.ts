import type { Settings } from '../../config/settings.js';
import { audit, type AppContext } from '../../context.js';
import type { ListingItemRow, ListingRow } from '../../db/schema.js';
import { kstDate } from '../../lib/util.js';
import { guardPriceChange } from '../pricing/pricing.js';
import { pauseListing } from './control.js';
import { getItems } from './items.js';

/**
 * 아이템위너 대응.
 * 쿠팡은 같은 상품(오너클랜 위탁 상품은 여러 판매자가 같은 이미지·상품명으로 올려 자동으로 한 상품으로 묶임)을
 * 판매자 1명(아이템위너)만 대표로 노출한다. 위너는 주로 판매가+배송비(단위가격 포함)·재고·출고소요기간·판매자점수로 정해진다.
 * 쿠팡 OPEN API는 위너 여부·카탈로그 매칭·자동가격조정을 제공하지 않으므로(쿠팡 개발자센터 FAQ),
 * 사람이 Wing 가격관리에서 본 위너 가격을 입력하면:
 *  - 하한가(최소 이익) 안에서 위너보다 싸게 맞출 수 있으면 → 1개 옵션 가격을 위너 −undercut(10원 단위)로
 *  - 못 맞추면(맞추면 손실) → 판매종료(노출이 거의 없어 자리만 차지, 다음 선정에서 교체)
 * 입력한 위너 가격은 capDays 동안 가격 상한으로 남아, 이후 원가 변동·가격 최적화가 위너 가격 위로 올리지 않는다.
 * 묶음(2개·3개) 옵션은 단위가격이 1개 옵션보다 싸서 그대로 둔다.
 */

export type WinnerPlan =
  | { action: 'keep'; price: number; floor: number; target: number; message: string }
  | { action: 'reprice'; price: number; floor: number; target: number; partial: boolean; message: string }
  | { action: 'stop'; price: number; floor: number; target: number; message: string };

const down10 = (n: number) => Math.floor(n / 10) * 10;

/** 위너보다 싸게 팔 목표가(10원 단위 내림) */
export function beatPrice(s: Settings, winnerTotal: number): number {
  return down10(winnerTotal - s.itemWinner.undercutKrw);
}

/** 순수 계산: 지금 가격·하한가·위너 가격(판매가+배송비) → 할 일 */
export function planWinner(s: Settings, opts: { current: number; floor: number; winnerTotal: number; changesToday: number }): WinnerPlan {
  const { current, floor, winnerTotal } = opts;
  const target = beatPrice(s, winnerTotal);
  const won = (n: number) => `${n.toLocaleString()}원`;
  if (current <= target) {
    return { action: 'keep', price: current, floor, target, message: `이미 위너 가격(${won(winnerTotal)})보다 싸게 팔고 있습니다(${won(current)}). 가격 외 요인(출고소요기간·판매자점수·재고)일 수 있어 가격은 그대로 둡니다.` };
  }
  if (target < floor) {
    return { action: 'stop', price: current, floor, target, message: `위너 가격 ${won(winnerTotal)}보다 싸게 팔면 최소 이익 기준(하한가 ${won(floor)})을 못 지킵니다 → 판매종료(노출이 거의 없어 자리만 차지, 다음 선정에서 새 상품으로 교체)` };
  }
  const g = guardPriceChange(s, { current, desired: target, floor, changesToday: opts.changesToday, unit: 10 });
  if (g.price === null) {
    return { action: 'reprice', price: current, floor, target, partial: true, message: `목표 ${won(target)}(위너 ${won(winnerTotal)} − ${s.itemWinner.undercutKrw}원). 오늘 가격 변경 횟수를 다 써서 다음 동기화(1시간 내외, 날짜가 바뀐 뒤)에 맞춥니다.` };
  }
  const partial = g.price > target;
  return {
    action: 'reprice', price: g.price, floor, target, partial,
    message: partial
      ? `목표 ${won(target)}(위너 ${won(winnerTotal)} − ${s.itemWinner.undercutKrw}원). 한 번에 내릴 수 있는 폭(−${Math.round(s.pricing.maxChangeRatioDown * 100)}%) 때문에 이번엔 ${won(g.price)}, 나머지는 다음 동기화에서 이어서 내립니다.`
      : `${won(current)} → ${won(g.price)}(위너 ${won(winnerTotal)}보다 ${won(winnerTotal - g.price)} 싸게, 하한가 ${won(floor)} 이상)`,
  };
}

/** 1개 옵션(가격 비교 기준) */
export async function baseItem(ctx: AppContext, l: ListingRow): Promise<ListingItemRow> {
  const items = await getItems(ctx, l);
  return items.find((i) => i.unit_qty === 1) ?? items[0]!;
}

/** 입력한 위너 가격이 아직 유효하면 1개 옵션 가격 상한(위너 −undercut), 아니면 null */
export function winnerCap(s: Settings, l: Pick<ListingRow, 'winner_status' | 'winner_price' | 'winner_checked_at'>, now: Date): number | null {
  if (l.winner_status !== 'not_winner' || !l.winner_price || !l.winner_checked_at) return null;
  if (now.getTime() - new Date(l.winner_checked_at).getTime() > s.itemWinner.capDays * 86400_000) return null;
  return beatPrice(s, l.winner_price);
}

/**
 * 1개 옵션 가격을 정확히 이 가격으로(10원 단위, 하한가·가드 적용). 판매가 끝자리(○,900) 올림을 하지 않는다.
 * 반환: 실제로 바뀌었는지와 적용 가격
 */
export async function setBasePrice(ctx: AppContext, l: ListingRow, desired: number, reason: string): Promise<{ changed: boolean; price: number }> {
  const s = await ctx.settings.get();
  const it = await baseItem(ctx, l);
  const today = kstDate(ctx.clock.now());
  const count = l.price_changes_date === today ? l.price_changes_count : 0;
  const g = guardPriceChange(s, { current: it.sale_price, desired, floor: it.floor_price, changesToday: count, unit: 10 });
  if (g.price === null) return { changed: false, price: it.sale_price };
  if (it.vendor_item_id) {
    const r = await ctx.market.updatePrice(it.vendor_item_id, g.price);
    if (!r.ok) {
      ctx.log.warn({ listing: l.id, msg: r.message }, '위너 가격 맞춤 실패');
      return { changed: false, price: it.sale_price };
    }
    await ctx.db.insertInto('price_changes').values({ listing_id: l.id, old_price: it.sale_price, new_price: g.price, reason, dry_run: !!r.dryRun, at: ctx.clock.now() }).execute();
  }
  const now = ctx.clock.now();
  if (it.id) await ctx.db.updateTable('listing_items').set({ sale_price: g.price }).where('id', '=', it.id).execute();
  await ctx.db.updateTable('listings').set({
    sale_price: g.price,
    markup: Math.max(0, g.price / it.floor_price - 1),
    price_changes_date: today, price_changes_count: count + 1, price_set_at: now, updated_at: now,
  }).where('id', '=', l.id).execute();
  return { changed: true, price: g.price };
}

/**
 * 관리 화면 [아이템위너 대응]: Wing 가격관리에서 본 위너의 판매가+배송비를 입력.
 * apply=false 면 미리보기만(아무것도 바꾸지 않음).
 */
export async function respondToWinner(ctx: AppContext, listingId: number, winnerTotal: number, apply: boolean, actor: string): Promise<WinnerPlan & { applied: boolean; listingStatus: string }> {
  const s = await ctx.settings.get();
  const l = await ctx.db.selectFrom('listings').selectAll().where('id', '=', listingId).executeTakeFirstOrThrow();
  if (!['active', 'paused'].includes(l.status)) throw Object.assign(new Error('판매중·일시중지 상품만 대응할 수 있습니다'), { statusCode: 400 });
  if (!(winnerTotal > 0)) throw Object.assign(new Error('위너 가격(판매가+배송비)을 입력하세요'), { statusCode: 400 });
  const it = await baseItem(ctx, l);
  const today = kstDate(ctx.clock.now());
  const plan = planWinner(s, { current: it.sale_price, floor: it.floor_price, winnerTotal, changesToday: l.price_changes_date === today ? l.price_changes_count : 0 });
  if (!apply) return { ...plan, applied: false, listingStatus: l.status };
  if (s.killSwitch) throw Object.assign(new Error('긴급 정지 중입니다'), { statusCode: 400 });

  const now = ctx.clock.now();
  await ctx.db.updateTable('listings').set({ winner_status: 'not_winner',winner_price: Math.round(winnerTotal), winner_checked_at: now, updated_at: now }).where('id', '=', l.id).execute();
  // 같은 키워드의 쿠팡 가격 수준 학습(선정 게이트·가격 최적화가 쿠팡 최저가로 사용)
  if (l.candidate_id) {
    const c = await ctx.db.selectFrom('candidates').select('keyword').where('id', '=', l.candidate_id).executeTakeFirst();
    if (c) await ctx.db.insertInto('market_signals').values({ keyword: c.keyword, kind: 'coupang_lowest', value: Math.round(winnerTotal), meta: JSON.stringify({ source: 'wing-item-winner', listingId: l.id }), at: now }).execute();
  }
  let status = l.status;
  if (plan.action === 'reprice' && plan.price !== it.sale_price) {
    const fresh = await ctx.db.selectFrom('listings').selectAll().where('id', '=', l.id).executeTakeFirstOrThrow();
    await setBasePrice(ctx, fresh, plan.target, `아이템위너 대응(위너 ${Math.round(winnerTotal).toLocaleString()}원)`);
  } else if (plan.action === 'stop') {
    const fresh = await ctx.db.selectFrom('listings').selectAll().where('id', '=', l.id).executeTakeFirstOrThrow();
    await pauseListing(ctx, fresh, `아이템위너 경쟁 불가: 위너 ${Math.round(winnerTotal).toLocaleString()}원 < 하한가 ${it.floor_price.toLocaleString()}원`, true);
    status = 'stopped';
  }
  await audit(ctx, actor, 'listing.item_winner', String(l.id), { winnerTotal, action: plan.action, price: plan.price, target: plan.target });
  return { ...plan, applied: true, listingStatus: status };
}

/** 관리 화면 [위너 맞음]: 위너 상태 기록(가격 상한 해제) */
export async function markWinner(ctx: AppContext, listingId: number, actor: string): Promise<void> {
  const now = ctx.clock.now();
  await ctx.db.updateTable('listings').set({ winner_status: 'winner', winner_price: null, winner_checked_at: now, updated_at: now }).where('id', '=', listingId).execute();
  await audit(ctx, actor, 'listing.item_winner_ok', String(listingId), {});
}
