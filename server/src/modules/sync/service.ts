import type { Settings } from '../../config/settings.js';
import type { AppContext } from '../../context.js';
import type { ListingRow } from '../../db/schema.js';
import { addDays, errMessage } from '../../lib/util.js';
import type { SourceProductDetail } from '../../ports/source.js';
import { upsertSourceProduct } from '../catalog.js';
import { PAUSE, pauseKind, pauseListing, resumeListing } from '../listing/control.js';
import { reprice } from '../listing/items.js';
import { getHalt } from '../guard/safety.js';
import { computeProfit, markupCapForMarket } from '../pricing/pricing.js';

/**
 * 판매 중 상품이 공급처에서 지금도 팔 수 있는지 판단. 문제가 있으면 판매중지 사유, 없으면 null.
 * (주문 가능 = 상품·옵션 판매중 + 오픈마켓 판매 허용 + 재고 여유)
 */
export function supplyProblem(s: Settings, d: SourceProductDetail | null): string | null {
  if (!d) return `${PAUSE.notSellable}: 공급처에서 상품이 삭제됨`;
  if (d.status === 'ended') return `${PAUSE.notSellable}: ${d.unavailableReason ?? '공급처 판매 종료'}`;
  if (d.status !== 'active') return d.unavailableReason ? `${PAUSE.soldout}: ${d.unavailableReason}` : PAUSE.soldout;
  if (d.marketSellable === false) return `${PAUSE.notSellable}: 오픈마켓 판매 금지 상품으로 변경됨`;
  const minStock = s.monitor.enabled ? s.monitor.minSourceStock : 1;
  if (d.stock !== null && d.stock < minStock) return d.stock <= 0 ? PAUSE.soldout : `${PAUSE.lowStock}: 재고 ${d.stock}개(기준 ${minStock}개)`;
  return null;
}

/**
 * 운영 중 상품의 공급가·재고 동기화 + 판매 가능 감시(구매자 보호).
 * - 판매 불가(품절·단종·옵션 삭제·오픈마켓 판매 금지·재고 부족·공급처에서 삭제) → 판매중지, 회복 → 재개
 * - 쿠팡에 올린 옵션(source_option)만 본다: 그 옵션이 품절이면 다른 옵션으로 바꾸지 않고 판매중지
 * - 공급가가 바뀌면 옵션별 하한가를 다시 계산하고 현재 마크업으로 판매가 재설정(하한 미만 금지)
 * - 가드(1회 변동률·하루 횟수) 때문에 하한·최저판매준수가를 못 맞추면 판매중지
 * - 같은 상품만 공급처 조회가 계속 실패하면(다른 상품은 정상) 확인 불가로 판매중지
 * - 재고 수량 반영
 * 사람이 멈춘 상품·안전장치·쿠팡에서 멈춘 상품은 건드리지 않는다. 주문 불가로 멈춘 상품은 주문 점검이 재개한다.
 */
export async function syncListings(ctx: AppContext): Promise<{ checked: number; paused: number; resumed: number; repriced: number; errors: number }> {
  const s = await ctx.settings.get();
  const stats = { checked: 0, paused: 0, resumed: 0, repriced: 0, errors: 0 };
  if (s.killSwitch) return stats;
  const halted = !!(await getHalt(ctx));
  const listings = await ctx.db.selectFrom('listings').selectAll().where('status', 'in', ['active', 'paused']).orderBy('id').execute();
  const pausedNow: Array<{ title: string; reason: string }> = [];
  const resumedNow: string[] = [];
  const optionUnset: string[] = [];
  const okSources = new Set<string>();
  const failed: Array<{ l: ListingRow; source: string; fails: number }> = [];
  const pause = async (l: ListingRow, reason: string) => {
    // 이미 공급처 사유로 멈춘 상품: 사유만 최신으로(주문 불가로 멈춘 상품은 사유 유지 → 주문 점검이 재개 판단)
    if (l.status === 'paused') {
      if (pauseKind(l.status_reason) === 'supply' && l.status_reason !== reason) {
        await ctx.db.updateTable('listings').set({ status_reason: reason.slice(0, 300) }).where('id', '=', l.id).execute();
      }
      return;
    }
    if (await pauseListing(ctx, l, reason)) {
      stats.paused++;
      pausedNow.push({ title: l.title, reason });
    }
  };
  for (const l of listings) {
    const kind = pauseKind(l.status_reason);
    if (l.status === 'paused' && kind === 'other') continue; // 수동·안전장치·쿠팡에서 중지는 건드리지 않음
    const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', l.source_product_id).executeTakeFirstOrThrow();
    const src = ctx.sources.get(sp.source);
    if (!src?.capabilities.detail) continue;
    stats.checked++;
    try {
      const d = await src.getProduct(sp.source_item_id, { title: sp.title, ...(l.source_option ? { option: l.source_option } : {}) });
      okSources.add(sp.source);
      await ctx.db.updateTable('listings').set({ checked_at: ctx.clock.now(), check_fails: 0 }).where('id', '=', l.id).execute();
      if (d) await upsertSourceProduct(ctx, sp.source, d);
      // 옵션이 여러 개인 공급처 상품인데 판매할 옵션이 정해지지 않은 채 올라감(이전 버전·도매꾹) → 구매자가 다른 색·사이즈를 받을 수 있어 판매중지
      const variants = (d?.options ?? []).filter((o) => o.name).length;
      if (l.status === 'active' && !l.dry_run && !l.source_option && variants > 1) {
        if (await pauseListing(ctx, l, `${PAUSE.optionUnset}: 공급처 옵션 ${variants}개 중 어떤 것을 파는지 정해지지 않음 — [옵션 지정해 다시 등록]`)) optionUnset.push(l.title);
        continue;
      }
      const problem = supplyProblem(s, d);
      if (problem || !d) {
        await pause(l, problem ?? PAUSE.notSellable);
        continue;
      }
      const costChanged = d.price !== sp.price || d.shippingFee !== sp.shipping_fee;
      let current: ListingRow = l;
      if (costChanged || l.floor_price > l.sale_price || (d.minResalePrice ?? 0) > l.sale_price) {
        const r = await reprice(ctx, l, l.markup, d.price > sp.price ? '공급가 상승' : '공급가 변동');
        if (r.changed) stats.repriced++;
        current = { ...l, sale_price: r.price, floor_price: r.floor };
      }
      const profit = computeProfit(s, current.sale_price, { cost: d.price, shipping: d.shippingFee, categoryPath: d.categoryPath, inputVatDeductible: d.taxInvoice, feeRate: l.fee_rate_actual }).profit;
      if (profit < 0) {
        await pause(current, `${PAUSE.margin}: 예상 손익 ${profit.toLocaleString()}원`);
        continue;
      }
      if (d.minResalePrice && current.sale_price < d.minResalePrice) {
        await pause(current, `${PAUSE.minResale}: 판매가 ${current.sale_price.toLocaleString()}원 < 준수가 ${d.minResalePrice.toLocaleString()}원`);
        continue;
      }
      // 공급처 사유로 멈춘 상품만 재개. 안전장치 판매 중지 중에는 재개하지 않음
      if (current.status === 'paused' && kind === 'supply' && !halted && (await resumeListing(ctx, current))) {
        stats.resumed++;
        resumedNow.push(l.title);
      }
      if (d.stock !== null) for (const it of await ctx.db.selectFrom('listing_items').selectAll().where('listing_id', '=', l.id).execute()) {
        if (it.vendor_item_id) await ctx.market.updateQuantity(it.vendor_item_id, Math.min(Math.floor(d.stock / it.unit_qty), 999));
      }
      if (d.stock !== null && current.vendor_item_id && !(await ctx.db.selectFrom('listing_items').select('id').where('listing_id', '=', l.id).executeTakeFirst())) {
        await ctx.market.updateQuantity(current.vendor_item_id, Math.min(d.stock, 999));
      }
    } catch (e) {
      stats.errors++;
      const fails = l.check_fails + 1;
      await ctx.db.updateTable('listings').set({ check_fails: fails }).where('id', '=', l.id).execute();
      failed.push({ l, source: sp.source, fails });
      ctx.log.warn({ listing: l.id, fails, err: errMessage(e) }, '동기화 실패');
    }
  }
  // 같은 공급처의 다른 상품은 정상 조회되는데 이 상품만 계속 실패 → 이 상품을 확인할 수 없음(공급처 전체 장애는 제외)
  if (s.monitor.enabled) {
    for (const f of failed) {
      if (f.l.status !== 'active' || f.fails < s.monitor.unverifiableStreak || !okSources.has(f.source)) continue;
      await pause(f.l, `${PAUSE.unverifiable}: 공급처 조회 ${f.fails}회 연속 실패`);
    }
  }
  if (stats.paused) {
    const lines = pausedNow.slice(0, 8).map((x) => `• ${x.title.slice(0, 28)} — ${x.reason}`);
    await ctx.notifications.notify('warn', `상품 ${stats.paused}개 자동 판매중지`,
      `${lines.join('\n')}${pausedNow.length > 8 ? `\n외 ${pausedNow.length - 8}개` : ''}\n공급처에서 주문할 수 없는 상태라 쿠팡 판매를 멈췄습니다. 회복되면 자동 재개됩니다.`, { path: '/listings' });
  }
  if (optionUnset.length) {
    await ctx.notifications.notify('action', `옵션이 정해지지 않은 상품 ${optionUnset.length}개 판매중지`,
      `${optionUnset.slice(0, 8).map((t) => `• ${t.slice(0, 28)}`).join('\n')}\n공급처에 색상·사이즈 옵션이 여러 개인데 어떤 옵션을 파는지 정해지지 않은 채 올라가(쿠팡 옵션: 멀티/FREE 등) 구매자가 다른 옵션을 받을 수 있습니다.\n관리 화면 상품 > 해당 상품 > [옵션 지정해 다시 등록]을 누르면 옵션(예: 3호 화이트)을 정해 새로 등록합니다. 이전 쿠팡 상품은 Wing에서 삭제하면 자동 정리됩니다.`,
      { path: '/listings' });
  }
  if (stats.resumed) await ctx.notifications.notify('info', `상품 ${stats.resumed}개 판매 재개`, resumedNow.slice(0, 8).map((t) => `• ${t.slice(0, 28)}`).join('\n'), { path: '/listings' });
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
        // 쿠팡에 올린 옵션이 그대로 있고 주문 가능한 상품만(다른 옵션이 오면 안 됨)
        const d = await src.getProduct(c.sourceItemId, { title: c.title, ...(l.source_option ? { option: l.source_option } : {}) });
        if (supplyProblem(s, d) || !d || (d.stock !== null && d.stock < s.selection.minStock) || (d.minOrderQty ?? 1) > 1) continue;
        if ((l.source_option ?? null) !== (d.defaultOption ?? null)) continue;
        if (d.price + d.shippingFee > current * (1 - s.costScout.minSaving)) continue; // 옵션 가격 기준으로 다시 확인
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

/**
 * 판매 부진: 등록 후 N일(최근 N일) 판매 0이면 하한가로 한 번 내려 보고, 그 뒤에도 0건이면 판매종료 → 다음 선정에서 교체.
 * 취소된 주문은 판매로 치지 않는다. 다시 팔리면 하한가 시험 이력을 지워 다음 부진 때 다시 한 번 내려 본다.
 */
export async function reviewSlowListings(ctx: AppContext): Promise<{ lowered: number; stopped: number }> {
  const s = await ctx.settings.get();
  const out = { lowered: 0, stopped: 0 };
  if (s.killSwitch) return out;
  const cutoff = addDays(ctx.clock.now(), -s.listing.zeroSaleDays);
  const rows = await ctx.db.selectFrom('listings').selectAll().where('status', '=', 'active').where('listed_at', '<', cutoff).execute();
  for (const l of rows) {
    const since = new Date(l.listed_at!);
    const sold = await ctx.db.selectFrom('orders').select((eb) => eb.fn.countAll<number>().as('n')).where('listing_id', '=', l.id)
      .where('ordered_at', '>=', cutoff).where('status', '!=', 'CANCELLED').executeTakeFirst();
    if (Number(sold?.n ?? 0) > 0) {
      if (l.zero_sale_adjusted) await ctx.db.updateTable('listings').set({ zero_sale_adjusted: false }).where('id', '=', l.id).execute();
      continue;
    }
    if (since > cutoff) continue;
    if (l.markup > 0 && !l.zero_sale_adjusted) {
      // 최적화가 꺼져 있어도 한 번은 하한가로 시도
      await reprice(ctx, l, 0, '판매 부진 인하');
      await ctx.db.updateTable('listings').set({ zero_sale_adjusted: true, updated_at: ctx.clock.now() }).where('id', '=', l.id).execute();
      out.lowered++;
      continue;
    }
    const setAt = new Date(l.price_set_at ?? l.listed_at!);
    if (setAt > addDays(ctx.clock.now(), -s.listing.stopAfterLowerDays)) continue; // 하한가 시도 후 아직 기간이 안 지남
    await pauseListing(ctx, l, `판매 부진(${s.listing.zeroSaleDays}일 0건 → 하한가 ${s.listing.stopAfterLowerDays}일도 0건)`, true);
    out.stopped++;
  }
  if (out.stopped) await ctx.notifications.notify('info', `판매 부진 상품 ${out.stopped}개 종료`, '다음 선정 주기에 새 후보로 교체됩니다.', { path: '/listings' });
  return out;
}
