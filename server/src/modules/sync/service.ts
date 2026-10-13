import type { AppContext } from '../../context.js';
import type { ListingRow } from '../../db/schema.js';
import { addDays, errMessage, kstDate } from '../../lib/util.js';
import { upsertSourceProduct } from '../catalog.js';
import { pauseListing, resumeListing } from '../listing/control.js';
import { reprice } from '../listing/items.js';
import { computeProfit, markupCapForMarket } from '../pricing/pricing.js';

/**
 * 운영 중 상품의 공급가·재고 동기화.
 * - 품절/단종 → 판매중지(paused), 재입고 → 재개
 * - 공급가가 바뀌면 옵션별 하한가를 다시 계산하고 현재 마크업으로 판매가 재설정(하한 미만 금지)
 * - 가드(1회 변동률·하루 횟수) 때문에 하한을 못 맞추면 손실 방지를 위해 판매중지
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
      const costChanged = d.price !== sp.price || d.shippingFee !== sp.shipping_fee;
      let current: ListingRow = l;
      if (costChanged || l.floor_price > l.sale_price) {
        const r = await reprice(ctx, l, l.markup, d.price > sp.price ? '공급가 상승' : '공급가 변동');
        if (r.changed) stats.repriced++;
        current = { ...l, sale_price: r.price, floor_price: r.floor };
      }
      const profit = computeProfit(s, current.sale_price, { cost: d.price, shipping: d.shippingFee, categoryPath: d.categoryPath, inputVatDeductible: d.taxInvoice, feeRate: l.fee_rate_actual }).profit;
      if (profit < 0) {
        if (await pauseListing(ctx, current, '마진 역전')) stats.paused++;
        continue;
      }
      if (current.status === 'paused' && (await resumeListing(ctx, current))) stats.resumed++;
      if (d.stock !== null) for (const it of await ctx.db.selectFrom('listing_items').selectAll().where('listing_id', '=', l.id).execute()) {
        if (it.vendor_item_id) await ctx.market.updateQuantity(it.vendor_item_id, Math.min(Math.floor(d.stock / it.unit_qty), 999));
      }
      if (d.stock !== null && current.vendor_item_id && !(await ctx.db.selectFrom('listing_items').select('id').where('listing_id', '=', l.id).executeTakeFirst())) {
        await ctx.market.updateQuantity(current.vendor_item_id, Math.min(d.stock, 999));
      }
    } catch (e) {
      stats.errors++;
      ctx.log.warn({ listing: l.id, err: errMessage(e) }, '동기화 실패');
    }
  }
  if (stats.paused) await ctx.notifications.notify('warn', `상품 ${stats.paused}개 자동 판매중지`, '품절 또는 마진 역전. 재입고/가격 회복 시 자동 재개됩니다.', { path: '/listings', dedupeKey: `sync-paused-${kstDate(ctx.clock.now())}`, dedupeMinutes: 180 });
  return stats;
}

/**
 * 가격 자동 최적화(하루 이익 최대화, 언덕 오르기).
 * 가격을 바꾼 뒤 observeDays 이상 지나면 그 가격 구간의 성과로 판단:
 *  - 주문이 raiseMinOrders 이상 → 지금이 최고 기록이면 기록하고 마크업 +stepUp (경쟁 최저가·상한 이내)
 *  - 일부 팔리지만 하루 이익이 최고 기록의 revertRatio 미만 → 최고 기록 마크업으로 복귀
 *  - noSaleDays 동안 0건 → 올렸다가 안 팔리면 최고 기록으로 복귀, 아니면 마크업 −stepDown(0까지)
 */
export async function optimizePrices(ctx: AppContext): Promise<{ checked: number; raised: number; lowered: number; reverted: number }> {
  const s = await ctx.settings.get();
  const o = s.optimizer;
  const out = { checked: 0, raised: 0, lowered: 0, reverted: 0 };
  if (!o.enabled || s.killSwitch) return out;
  const now = ctx.clock.now();
  const listings = await ctx.db.selectFrom('listings').selectAll().where('status', '=', 'active').where('vendor_item_id', 'is not', null).execute();
  for (const l of listings) {
    const since = new Date(l.price_set_at ?? l.listed_at ?? l.created_at);
    const days = (now.getTime() - since.getTime()) / 86400_000;
    const listedDays = (now.getTime() - new Date(l.listed_at ?? l.created_at).getTime()) / 86400_000;
    // 출시 기간: 낮은 가격 유지(초기 판매·리뷰가 쿠팡 노출을 좌우)
    if (listedDays < s.pricing.launchDays) continue;
    if (days < o.observeDays) continue;
    out.checked++;
    const agg = await ctx.db
      .selectFrom('orders')
      .select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.coalesce(eb.fn.sum<number>('expected_profit'), eb.lit(0)).as('profit')])
      .where('listing_id', '=', l.id)
      .where('ordered_at', '>=', since)
      .where('status', 'not in', ['CANCELLED'])
      .executeTakeFirst();
    const n = Number(agg?.n ?? 0);
    const dailyProfit = Number(agg?.profit ?? 0) / days;
    const marketLowest = await latestMarketLowest(ctx, l);
    const cap = markupCapForMarket(s, l.floor_price, marketLowest);
    const best = l.best_daily_profit ?? 0;
    let next: number | null = null;
    let reason = '';
    // 출시 직후 첫 판단: 출시 가격에서 팔렸으면 목표(중간 지점)로 바로 이동
    const launchEnded = l.target_markup !== null && l.markup < l.target_markup && l.best_markup === null;
    // 판매 속도 보호: 직전 같은 길이 기간보다 판매가 줄고 있으면 인상 보류
    const prev = await ctx.db.selectFrom('orders').select((eb) => eb.fn.countAll<number>().as('n')).where('listing_id', '=', l.id)
      .where('ordered_at', '>=', new Date(since.getTime() - days * 86400_000)).where('ordered_at', '<', since).where('status', 'not in', ['CANCELLED']).executeTakeFirst();
    const prevN = Number(prev?.n ?? 0);
    const slowing = prevN > 0 && n < prevN * o.velocityGuard;
    if (launchEnded && n > 0) {
      await ctx.db.updateTable('listings').set({ best_markup: l.markup, best_daily_profit: dailyProfit }).where('id', '=', l.id).execute();
      next = Math.min(cap, l.target_markup!);
      reason = `출시 기간 판매 ${n}건 → 목표 가격(경쟁가와의 중간 지점)`;
      out.raised++;
    } else if (n >= o.raiseMinOrders && slowing) {
      // 팔리긴 하지만 속도가 줄고 있음 → 유지
    } else if (n >= o.raiseMinOrders) {
      if (dailyProfit >= best) await ctx.db.updateTable('listings').set({ best_markup: l.markup, best_daily_profit: dailyProfit }).where('id', '=', l.id).execute();
      if (l.markup < cap) {
        next = Math.min(cap, l.markup + o.stepUp);
        reason = `최적화: 잘 팔림(${n}건) → 인상`;
        out.raised++;
      }
    } else if (n > 0) {
      if (l.best_markup !== null && l.best_markup !== l.markup && dailyProfit < best * o.revertRatio) {
        next = l.best_markup;
        reason = '최적화: 이익 감소 → 최고 가격으로 복귀';
        out.reverted++;
      }
    } else if (days >= o.noSaleDays) {
      if (l.best_markup !== null && l.markup > l.best_markup) {
        next = l.best_markup;
        reason = '최적화: 인상 후 판매 없음 → 최고 가격으로 복귀';
        out.reverted++;
      } else if (l.markup > 0) {
        next = Math.max(0, l.markup - o.stepDown);
        reason = `최적화: ${Math.floor(days)}일 판매 없음 → 인하`;
        out.lowered++;
      }
    }
    if (next === null || Math.abs(next - l.markup) < 1e-6) continue;
    try {
      const r = await reprice(ctx, l, next, reason);
      // 가드로 실제 가격이 안 바뀌어도 관찰 구간은 새로 시작
      if (!r.changed) await ctx.db.updateTable('listings').set({ markup: next, price_set_at: now }).where('id', '=', l.id).execute();
    } catch (e) {
      ctx.log.warn({ listing: l.id, err: errMessage(e) }, '가격 최적화 실패');
    }
  }
  return out;
}

/** 이 상품의 시장 최저가(쿠팡 우선) — 후보 선정 때 저장한 키워드 신호에서 */
async function latestMarketLowest(ctx: AppContext, l: ListingRow): Promise<number | null> {
  if (!l.candidate_id) return null;
  const c = await ctx.db.selectFrom('candidates').select(['keyword', 'market_lowest']).where('id', '=', l.candidate_id).executeTakeFirst();
  if (!c) return null;
  const recent = await ctx.db.selectFrom('market_signals').select('value').where('keyword', '=', c.keyword).where('kind', 'in', ['coupang_lowest', 'market_lowest'])
    .where('at', '>=', addDays(ctx.clock.now(), -14)).orderBy('at', 'desc').executeTakeFirst();
  return recent?.value ?? c.market_lowest ?? null;
}

/**
 * 원가 절감: 같은 공급처에서 상품명이 같은(다른 판매자 복제) 더 싼 상품을 찾아 공급처 상품을 교체.
 * 주문 자동발주 가능 여부가 같은 공급처 안에서만 바꾼다.
 */
export async function scoutCheaperSources(ctx: AppContext): Promise<{ checked: number; switched: number }> {
  const s = await ctx.settings.get();
  const out = { checked: 0, switched: 0 };
  if (!s.costScout.enabled || s.killSwitch) return out;
  const cutoff = addDays(ctx.clock.now(), -s.costScout.intervalDays);
  const listings = await ctx.db.selectFrom('listings').selectAll().where('status', '=', 'active')
    .where((eb) => eb.or([eb('cost_scouted_at', 'is', null), eb('cost_scouted_at', '<', cutoff)])).limit(30).execute();
  const norm = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  for (const l of listings) {
    await ctx.db.updateTable('listings').set({ cost_scouted_at: ctx.clock.now() }).where('id', '=', l.id).execute();
    const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', l.source_product_id).executeTakeFirstOrThrow();
    const src = ctx.sources.get(sp.source);
    if (!src?.capabilities.search || !src.capabilities.detail) continue;
    out.checked++;
    try {
      const target = norm(sp.title);
      const found = (await src.search(sp.title.slice(0, 40), { limit: 30 })).filter((x) => x.sourceItemId !== sp.source_item_id && norm(x.title) === target);
      const current = sp.price + sp.shipping_fee;
      const cheaper = found.filter((x) => x.price + x.shippingFee <= current * (1 - s.costScout.minSaving)).sort((a, b) => a.price + a.shippingFee - (b.price + b.shippingFee));
      for (const c of cheaper) {
        const d = await src.getProduct(c.sourceItemId, { title: c.title });
        if (!d || d.status !== 'active' || (d.stock !== null && d.stock < s.selection.minStock) || (d.minOrderQty ?? 1) > 1) continue;
        const np = await upsertSourceProduct(ctx, sp.source, d);
        await ctx.db.updateTable('listings').set({ source_product_id: np.id, updated_at: ctx.clock.now() }).where('id', '=', l.id).execute();
        await reprice(ctx, { ...l, source_product_id: np.id }, l.markup, '원가 절감(더 싼 동일 상품으로 교체)');
        await ctx.notifications.notify('info', '더 싼 공급처로 교체', `${l.title}: 원가 ${current.toLocaleString()}원 → ${(d.price + d.shippingFee).toLocaleString()}원`, { path: '/listings' });
        out.switched++;
        break;
      }
    } catch (e) {
      ctx.log.warn({ listing: l.id, err: errMessage(e) }, '원가 탐색 실패');
    }
  }
  return out;
}

/** 판매 부진: 마크업 0(하한가)까지 내렸는데도 N일 판매 0이면 판매종료 → 다음 선정에서 교체 */
export async function reviewSlowListings(ctx: AppContext): Promise<{ lowered: number; stopped: number }> {
  const s = await ctx.settings.get();
  const out = { lowered: 0, stopped: 0 };
  if (s.killSwitch) return out;
  const cutoff = addDays(ctx.clock.now(), -s.listing.zeroSaleDays);
  const rows = await ctx.db.selectFrom('listings').selectAll().where('status', '=', 'active').where('listed_at', '<', cutoff).execute();
  for (const l of rows) {
    const since = new Date(l.listed_at!);
    const sold = await ctx.db.selectFrom('orders').select((eb) => eb.fn.countAll<number>().as('n')).where('listing_id', '=', l.id).where('ordered_at', '>=', addDays(ctx.clock.now(), -s.listing.zeroSaleDays)).executeTakeFirst();
    if (Number(sold?.n ?? 0) > 0 || since > cutoff) continue;
    if (l.markup > 0 && !l.zero_sale_adjusted) {
      // 최적화가 꺼져 있어도 한 번은 하한가로 시도
      await reprice(ctx, l, 0, '판매 부진 인하');
      await ctx.db.updateTable('listings').set({ zero_sale_adjusted: true, updated_at: ctx.clock.now() }).where('id', '=', l.id).execute();
      out.lowered++;
      continue;
    }
    const setAt = new Date(l.price_set_at ?? l.listed_at!);
    if (setAt > cutoff) continue; // 마지막 가격 조정 후 아직 기간이 안 지남
    await pauseListing(ctx, l, `판매 부진(${s.listing.zeroSaleDays}일 0건)`, true);
    out.stopped++;
  }
  if (out.stopped) await ctx.notifications.notify('info', `판매 부진 상품 ${out.stopped}개 종료`, '다음 선정 주기에 새 후보로 교체됩니다.', { path: '/listings' });
  return out;
}
