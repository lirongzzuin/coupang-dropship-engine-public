import type { Settings } from '../../config/settings.js';
import { audit, type AppContext } from '../../context.js';
import type { ListingRow, SourceProductRow } from '../../db/schema.js';
import { addDays, errMessage, HttpError } from '../../lib/util.js';
import type { SourceOrderCheck } from '../../ports/source.js';
import { detailOf } from '../catalog.js';
import { getHalt } from '../guard/safety.js';
import { getItems, vendorItemIds } from '../listing/items.js';
import { PAUSE, pauseKind, pauseListing, resumeListing } from '../listing/control.js';
import { computeProfit } from '../pricing/pricing.js';

/**
 * 판매 중 상품 감시(구매자 보호) — 동기화(syncListings)가 못 보는 것을 본다.
 * 1) 주문 가능 점검: 공급처 주문 시뮬레이션(실제 주문 없음)으로 "지금 주문이 들어오면 정말 발주되는지"와 실주문 금액 확인
 * 2) 쿠팡 판매상태 대조: 우리가 멈춘 상품이 쿠팡에서 판매중이면 다시 멈춤, 쿠팡(Wing)에서 멈춘 상품은 자동 재개하지 않게 기록
 * 3) 장기 판매불가 정리: 품절·주문 불가로 오래 멈춘 상품은 판매종료(교체 대상)
 */

/** 사람이 멈춘 사유(관리 화면 중지·Wing/쿠팡 중지) — Wing에서 다시 판매하면 그 결정을 따른다 */
const MANUAL_PAUSES = ['관리자 중지', PAUSE.wing];

/** 시뮬레이션용 받는 곳: 우리 반품지(실제 주문이 아니므로 고객 정보는 쓰지 않음) */
function checkReceiver(s: Settings): { name: string; phone: string; addr1: string; addr2: string; zip: string } | null {
  const phone = s.orders.senderPhone || s.coupang.companyContactNumber;
  if (!s.coupang.returnAddress || !s.coupang.returnZipCode || !phone) return null;
  return { name: s.orders.senderName || s.coupang.returnChargeName || '주문점검', phone, addr1: s.coupang.returnAddress, addr2: s.coupang.returnAddressDetail || '', zip: s.coupang.returnZipCode };
}

export interface OrderabilityResult {
  checked: number;
  ok: number;
  paused: number;
  resumed: number;
  /** 일시 오류(다음 실행에서 다시 점검) */
  transient: number;
  /** 연동 문제 의심(다수 실패) → 상품을 멈추지 않고 알림 */
  systemic: boolean;
  skipped?: string;
}

/**
 * 주문 가능 점검. 판매중 상품 + '주문 불가'로 멈춘 상품을 simulateEveryHours 마다 공급처 주문 시뮬레이션.
 * - 공급처가 거부(상품·옵션 주문 불가) → 판매중지('주문 불가'), 다음 점검에서 통과하면 재개
 * - 실주문 금액(상품+배송비) 기준 손실이면 판매중지, 예상보다 비싸면 알림
 * - 한 번에 다수가 거부되면(연동·스키마 문제 의심) 상품을 멈추지 않고 알림
 */
export async function checkOrderability(ctx: AppContext): Promise<OrderabilityResult> {
  const s = await ctx.settings.get();
  const out: OrderabilityResult = { checked: 0, ok: 0, paused: 0, resumed: 0, transient: 0, systemic: false };
  if (s.killSwitch || !s.monitor.enabled || !s.monitor.simulateOrder) return out;
  const receiver = checkReceiver(s);
  if (!receiver) return { ...out, skipped: '반품지 주소·연락처 미설정(설정 > 쿠팡)' };
  const now = ctx.clock.now();
  const due = new Date(now.getTime() - s.monitor.simulateEveryHours * 3600_000);
  const rows = (await ctx.db.selectFrom('listings').selectAll()
    .where((eb) => eb.or([eb('status', '=', 'active'), eb.and([eb('status', '=', 'paused'), eb('status_reason', 'like', `${PAUSE.unorderable}%`)])]))
    .where((eb) => eb.or([eb('order_checked_at', 'is', null), eb('order_checked_at', '<', due)]))
    .execute())
    .sort((a, b) => (a.order_checked_at ? new Date(a.order_checked_at).getTime() : 0) - (b.order_checked_at ? new Date(b.order_checked_at).getTime() : 0));

  const results: Array<{ l: ListingRow; sp: SourceProductRow; r: SourceOrderCheck }> = [];
  for (const l of rows) {
    if (results.length >= s.monitor.simulatePerRun) break;
    const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', l.source_product_id).executeTakeFirstOrThrow();
    const src = ctx.sources.get(sp.source);
    if (!src?.checkOrderable) continue;
    let r: SourceOrderCheck;
    try {
      r = await src.checkOrderable({ sourceItemId: sp.source_item_id, option: l.source_option ?? detailOf(sp)?.defaultOption, qty: 1, receiver });
    } catch (e) {
      r = { ok: false, definitive: false, reason: errMessage(e) };
    }
    results.push({ l, sp, r });
  }
  out.checked = results.length;
  const refused = results.filter((x) => !x.r.ok && x.r.definitive);
  out.transient = results.filter((x) => !x.r.ok && !x.r.definitive).length;
  if (refused.length >= s.monitor.systemicFailCount && refused.length * 2 >= results.length) {
    out.systemic = true;
    const first = refused[0]!.r as { reason: string };
    await ctx.notifications.notify('error', '주문 가능 점검: 연동 문제 의심',
      `점검한 상품 ${results.length}개 중 ${refused.length}개를 공급처가 거부했습니다(예: ${first.reason}).\n상품 문제가 아니라 공급처 API·계정 문제일 수 있어 판매는 멈추지 않았습니다. 오너클랜 로그인·API 승인·예치금 상태를 확인하세요(bash ~/dropship/bin/check.sh).`,
      { path: '/listings', dedupeKey: 'orderability-systemic', dedupeMinutes: 360 });
    return out;
  }

  const halted = !!(await getHalt(ctx));
  const pausedNow: string[] = [];
  const resumedNow: string[] = [];
  const pricier: string[] = [];
  for (const { l, sp, r } of results) {
    if (!r.ok && !r.definitive) continue; // 일시 오류: 다음 실행에서 다시
    await ctx.db.updateTable('listings').set({ order_checked_at: now }).where('id', '=', l.id).execute();
    let problem: string | null = null;
    if (!r.ok) {
      problem = `${PAUSE.unorderable}: 공급처가 주문을 거부(${r.reason})`;
    } else {
      const actual = r.cost + r.shippingCost;
      const expected = sp.price + sp.shipping_fee;
      const profit = computeProfit(s, l.sale_price, { cost: r.cost, shipping: r.shippingCost, categoryPath: sp.category_path, inputVatDeductible: sp.tax_invoice, feeRate: l.fee_rate_actual }).profit;
      if (profit < 0) problem = `${PAUSE.unorderable}: 실주문 금액 ${actual.toLocaleString()}원 기준 손실(${profit.toLocaleString()}원)`;
      else if (actual > expected + s.monitor.costDriftKrw) pricier.push(`• ${l.title.slice(0, 28)} — 예상 ${expected.toLocaleString()}원 → 실주문 ${actual.toLocaleString()}원(이익 ${Math.round(profit).toLocaleString()}원)`);
    }
    if (problem) {
      if (l.status === 'active') {
        if (await pauseListing(ctx, l, problem)) {
          out.paused++;
          pausedNow.push(`• ${l.title.slice(0, 28)} — ${problem}`);
        }
      } else if (l.status_reason !== problem) {
        await ctx.db.updateTable('listings').set({ status_reason: problem.slice(0, 300) }).where('id', '=', l.id).execute();
      }
      continue;
    }
    out.ok++;
    // 주문 불가로 멈췄던 상품: 점검 통과 + 공급처 판매중이면 재개(안전장치 중지 중엔 재개 안 함)
    if (l.status === 'paused' && pauseKind(l.status_reason) === 'order' && !halted && sp.status === 'active' && (await resumeListing(ctx, l))) {
      out.resumed++;
      resumedNow.push(`• ${l.title.slice(0, 28)}`);
    }
  }
  if (pausedNow.length) {
    await ctx.notifications.notify('warn', `주문 불가 상품 ${pausedNow.length}개 판매중지`,
      `${pausedNow.slice(0, 8).join('\n')}\n공급처 주문 시뮬레이션이 실패해 쿠팡 판매를 멈췄습니다(실제 주문 없음). 다시 주문 가능해지면 자동 재개됩니다.`, { path: '/listings' });
  }
  if (resumedNow.length) await ctx.notifications.notify('info', `주문 가능 회복 ${resumedNow.length}개 판매 재개`, resumedNow.slice(0, 8).join('\n'), { path: '/listings' });
  if (pricier.length) {
    await ctx.notifications.notify('info', '실주문 금액이 예상보다 비싼 상품', `${pricier.slice(0, 8).join('\n')}\n이익은 남아 판매를 계속합니다. 옵션 추가금·배송비 정책을 확인하세요.`, { path: '/listings', dedupeKey: `order-cost-drift-${pricier.length}`, dedupeMinutes: 24 * 60 });
  }
  return out;
}

/**
 * 쿠팡 실제 판매상태 대조.
 * - 우리가 멈춘(일시중지·최근 판매종료) 상품인데 쿠팡에서 판매중 → 다시 판매중지(품절·주문 불가 상품 주문 차단)
 * - 우리는 판매중인데 쿠팡에서 모든 옵션이 판매중지 → Wing·쿠팡 조치로 보고 '쿠팡에서 판매중지됨'으로 기록(자동 재개 안 함)
 */
export async function reconcileMarketState(ctx: AppContext): Promise<ReconcileResult> {
  const s = await ctx.settings.get();
  const out: ReconcileResult = { checked: 0, restopped: 0, marketStopped: 0, errors: 0 };
  if (s.killSwitch || !s.monitor.enabled || !s.monitor.reconcileMarket || !ctx.market.getItemSaleState) return out;
  const recent = addDays(ctx.clock.now(), -7);
  const rows = await ctx.db.selectFrom('listings').selectAll().where('dry_run', '=', false)
    .where((eb) => eb.or([eb('status', 'in', ['active', 'paused']), eb.and([eb('status', '=', 'stopped'), eb('updated_at', '>=', recent)])]))
    .orderBy('id').execute();
  const restopped: string[] = [];
  const failed: string[] = [];
  const marketStopped: string[] = [];
  const adopted: string[] = [];
  const priceAdopted: string[] = [];
  const deleted: string[] = [];
  let lookups = 0;
  for (const l of rows) {
    // 설정 수정 심사 중인 상품은 쿠팡이 옵션 조회에 일시 오류(400)를 줌(실측) → 심사가 끝난 뒤 대조
    if (l.repair_state === 'requested') continue;
    const vids = await vendorItemIds(ctx, l);
    if (!vids.length) continue;
    out.checked++;
    let states: Array<{ vid: string; onSale: boolean; price: number | null; deleted?: boolean }> = [];
    for (const vid of vids) {
      lookups++;
      try {
        const st = await ctx.market.getItemSaleState(vid);
        if (st) states.push({ vid, onSale: st.onSale, price: st.price, deleted: st.deleted });
      } catch (e) {
        out.errors++;
        ctx.log.warn({ listing: l.id, vid, err: errMessage(e) }, '쿠팡 판매상태 조회 실패');
      }
    }
    // Wing에서 상품을 삭제 → 판매종료로 정리(관리 화면 기본 목록에서 빠지고, 같은 상품은 다시 등록하지 않음)
    // 실측(2026-10-14): 삭제된 상품의 옵션 조회는 오류가 아니라 정상 응답(onSale=false)이고 상품 조회가 '상품삭제'
    // → 옵션이 모두 판매중이 아니면 상품 상태로 삭제 여부 확인
    if (states.some((x) => x.deleted) || (states.length > 0 && states.length === vids.length && states.every((x) => !x.onSale))) {
      if (await productDeleted(ctx, l, states.every((x) => x.deleted) && states.length === vids.length)) {
        const now = ctx.clock.now();
        await ctx.db.updateTable('listings').set({ status: 'stopped', status_reason: `${PAUSE.deleted}(Wing에서 삭제)`, paused_at: null, updated_at: now }).where('id', '=', l.id).execute();
        out.deleted = (out.deleted ?? 0) + 1;
        deleted.push(`• ${l.title.slice(0, 28)}`);
        continue;
      }
      states = states.filter((x) => !x.deleted); // 일부 옵션만 삭제 → 나머지 옵션으로 판단
    }
    const seen = states.length;
    const onSale = states.filter((x) => x.onSale).length;
    // 사람이 멈춘 상품(관리 화면·Wing)을 Wing에서 다시 판매 시작 → 사람의 결정으로 보고 따름(공급처 상태는 동기화가 다시 확인)
    if (l.status === 'paused' && MANUAL_PAUSES.some((p) => l.status_reason?.startsWith(p)) && seen === vids.length && onSale === seen) {
      await ctx.db.updateTable('listings').set({ status: 'active', status_reason: null, paused_at: null, updated_at: ctx.clock.now() }).where('id', '=', l.id).execute();
      adopted.push(`• ${l.title.slice(0, 28)}`);
      continue;
    }
    // 옵션 단위로 멈춘 옵션(그 옵션만 품절 등)이 쿠팡에서 판매중이면 그 옵션도 다시 멈춤
    const pausedVids = new Set((await getItems(ctx, l)).filter((i) => i.item_status === 'paused' && i.vendor_item_id).map((i) => String(i.vendor_item_id)));
    for (const { vid, onSale: selling } of states) {
      if ((l.status !== 'active' || pausedVids.has(vid)) && selling) {
        const r = await ctx.market.stopSale(vid);
        if (r.dryRun) continue; // 모의 실행: 실제로 멈출 수 없음(LIVE_LISTING/LIVE_PRICING 꺼짐)
        if (r.ok) {
          out.restopped++;
          restopped.push(`• ${l.title.slice(0, 28)} (${l.status_reason ?? l.status})`);
        } else {
          failed.push(`• ${l.title.slice(0, 28)} 옵션 ${vid}: ${r.message}`);
        }
      }
    }
    if (l.status === 'active' && seen > 0 && seen === vids.length && onSale === 0) {
      const now = ctx.clock.now();
      await ctx.db.updateTable('listings').set({ status: 'paused', status_reason: `${PAUSE.wing}(Wing 또는 쿠팡 조치) — 확인 후 [판매재개]`, paused_at: now, updated_at: now }).where('id', '=', l.id).execute();
      out.marketStopped++;
      marketStopped.push(`• ${l.title.slice(0, 28)}`);
      continue;
    }
    // Wing에서 직접 바꾼 가격(사람이 가격 조정 등) → 시스템 가격으로 반영(덮어쓰지 않음), 손실이면 판매중지
    if (l.status === 'active' && s.monitor.adoptMarketPrice) {
      const r = await adoptMarketPrices(ctx, s, l, states);
      if (r) priceAdopted.push(r);
    }
  }
  // 모든 조회가 실패 → 대조가 사실상 꺼진 상태(키 권한·API 변경). 하루 한 번 알림
  if (out.errors > 0 && out.errors >= lookups) {
    await ctx.notifications.notify('warn', '쿠팡 판매상태 조회 실패', `옵션 ${lookups}개 조회가 모두 실패해 쿠팡 판매상태 대조를 하지 못했습니다(판매중지 누락 감지 불가). 쿠팡 API 키 권한·허용 IP를 확인하세요(bash ~/dropship/bin/check.sh).`,
      { path: '/jobs', dedupeKey: 'reconcile-all-failed', dedupeMinutes: 24 * 60 });
  }
  if (deleted.length) await ctx.notifications.notify('info', `쿠팡에서 삭제한 상품 ${deleted.length}개 정리`, `${deleted.slice(0, 8).join('\n')}\n판매종료로 정리했고 관리 화면 기본 목록에서 숨깁니다(판매종료 탭에서 확인). 같은 상품은 다시 등록하지 않습니다.`, { path: '/listings' });
  if (priceAdopted.length) {
    out.priceAdopted = priceAdopted.length;
    await ctx.notifications.notify('info', `쿠팡(Wing)에서 바뀐 가격 ${priceAdopted.length}개 반영`, `${priceAdopted.slice(0, 8).join('\n')}\n시스템 가격을 쿠팡 실제 가격에 맞췄습니다(손실 가격이면 판매중지).`, { path: '/listings' });
  }
  if (adopted.length) await ctx.notifications.notify('info', `Wing에서 판매 재개한 상품 ${adopted.length}개 반영`, `${adopted.slice(0, 8).join('\n')}\n공급처 상태는 다음 동기화에서 다시 확인합니다.`, { path: '/listings' });
  if (restopped.length) await ctx.notifications.notify('warn', `판매중지했던 상품 ${restopped.length}개가 쿠팡에서 판매중 → 다시 중지`, restopped.slice(0, 8).join('\n'), { path: '/listings' });
  if (failed.length) await ctx.notifications.notify('error', '쿠팡 판매중지 실패 — Wing에서 직접 중지하세요', `${failed.slice(0, 8).join('\n')}\n공급처에서 주문할 수 없는 상품이 쿠팡에서 판매중입니다.`, { path: '/listings', dedupeKey: `reconcile-fail-${failed.length}`, dedupeMinutes: 120 });
  if (marketStopped.length) {
    await ctx.notifications.notify('warn', `쿠팡에서 판매중지된 상품 ${marketStopped.length}개`,
      `${marketStopped.slice(0, 8).join('\n')}\nWing에서 직접 멈췄거나 쿠팡이 판매를 막았습니다(정책·심사). 자동으로 재개하지 않습니다. Wing 상품관리에서 사유를 확인하고, 괜찮으면 관리 화면 [판매재개]를 누르세요.`, { path: '/listings' });
  }
  return out;
}

export interface ReconcileResult {
  checked: number;
  restopped: number;
  marketStopped: number;
  errors: number;
  priceAdopted?: number;
  /** Wing에서 삭제돼 판매종료로 정리한 상품 */
  deleted?: number;
}

/**
 * 상품 자체가 쿠팡에서 삭제됐는지 상품 조회로 확인(옵션 하나만 지운 경우와 구분).
 * 상품 조회가 '상품삭제'이거나 없는 상품(400/404)이면 삭제. 일시 오류면 다음 실행에서 다시.
 * 등록상품ID를 모르면(기존 상품 연결분) 모든 옵션이 삭제로 보일 때만 삭제로 본다.
 */
async function productDeleted(ctx: AppContext, l: ListingRow, allOptionsDeleted: boolean): Promise<boolean> {
  if (!l.seller_product_id) return allOptionsDeleted;
  try {
    const st = await ctx.market.getProductStatus(l.seller_product_id);
    return st.rawStatus === '상품삭제';
  } catch (e) {
    if (e instanceof HttpError && (e.status === 400 || e.status === 404)) return allOptionsDeleted;
    ctx.log.warn({ listing: l.id, err: errMessage(e) }, '쿠팡 상품 조회 실패(삭제 확인 보류)');
    return false;
  }
}

/**
 * 쿠팡 실제 판매가가 시스템 가격과 다르면(사람이 Wing에서 바꿈) 반영.
 * - 방금 우리가 바꾼 가격의 반영 지연을 사람 변경으로 오인하지 않게: 최근 3시간 내 가격을 바꾼 상품은 건너뛰고,
 *   같은 다른 가격이 두 번 연속(1시간 간격) 보일 때만 반영
 * - 반영한 가격이 손실이면 판매중지(공급처 사유 → 동기화가 하한가로 올린 뒤 재개)
 */
async function adoptMarketPrices(ctx: AppContext, s: Settings, l: ListingRow, states: Array<{ vid: string; price: number | null }>): Promise<string | null> {
  const now = ctx.clock.now();
  if (l.price_set_at && now.getTime() - new Date(l.price_set_at).getTime() < 3 * 3600_000) return null;
  const items = await getItems(ctx, l);
  const changes: string[] = [];
  let lossReason: string | null = null;
  const sp = await ctx.db.selectFrom('source_products').selectAll().where('id', '=', l.source_product_id).executeTakeFirstOrThrow();
  const det = detailOf(sp);
  for (const st of states) {
    const key = `market.priceSeen.${st.vid}`;
    const it = items.find((i) => i.vendor_item_id === st.vid);
    if (!it || st.price === null || st.price <= 0 || st.price === it.sale_price) {
      if (await ctx.kv.get<number | null>(key)) await ctx.kv.set(key, null);
      continue;
    }
    if ((await ctx.kv.get<number | null>(key)) !== st.price) {
      await ctx.kv.set(key, st.price); // 첫 관찰: 다음 실행에서 같은 가격이면 반영
      continue;
    }
    await ctx.kv.set(key, null);
    if (it.id) await ctx.db.updateTable('listing_items').set({ sale_price: st.price }).where('id', '=', it.id).execute();
    if (it.unit_qty === 1) {
      await ctx.db.updateTable('listings').set({ sale_price: st.price, markup: Math.max(0, st.price / it.floor_price - 1), price_set_at: now, updated_at: now }).where('id', '=', l.id).execute();
    }
    changes.push(`${it.unit_qty}개 ${it.sale_price.toLocaleString()}→${st.price.toLocaleString()}원`);
    const units = it.unit_qty;
    const shipping = det?.shippingPerUnit ? sp.shipping_fee * units : det?.maxPerBox && units > det.maxPerBox ? sp.shipping_fee * Math.ceil(units / det.maxPerBox) : sp.shipping_fee;
    const profit = computeProfit(s, st.price, { cost: sp.price * units, shipping, categoryPath: sp.category_path, inputVatDeductible: sp.tax_invoice, feeRate: l.fee_rate_actual }).profit;
    if (profit < 0 && !lossReason) lossReason = `${PAUSE.margin}: 쿠팡(Wing)에서 바뀐 가격 ${st.price.toLocaleString()}원(${units}개) 기준 손실 ${Math.round(profit).toLocaleString()}원`;
  }
  if (!changes.length) return null;
  await audit(ctx, 'monitor', 'listing.market_price_adopted', String(l.id), { changes });
  if (lossReason) {
    const fresh = await ctx.db.selectFrom('listings').selectAll().where('id', '=', l.id).executeTakeFirstOrThrow();
    await pauseListing(ctx, fresh, lossReason);
    return `• ${l.title.slice(0, 24)}: ${changes.join(', ')} → ⛔ 손실이라 판매중지`;
  }
  return `• ${l.title.slice(0, 24)}: ${changes.join(', ')}`;
}

/** 공급처 품절·주문 불가로 stalePausedDays 넘게 판매중지된 상품 → 판매종료(상한·감시 대상에서 빠지고 새 상품으로 교체) */
export async function retireStalePaused(ctx: AppContext): Promise<{ retired: number }> {
  const s = await ctx.settings.get();
  const out = { retired: 0 };
  if (s.killSwitch || !s.prune.enabled) return out;
  const cutoff = new Date(ctx.clock.now().getTime() - s.prune.stalePausedDays * 86400_000);
  const rows = await ctx.db.selectFrom('listings').selectAll().where('status', '=', 'paused').where('paused_at', '<', cutoff).execute();
  const titles: string[] = [];
  for (const l of rows) {
    if (pauseKind(l.status_reason) === 'other') continue; // 사람·안전장치·쿠팡 중지는 사람이 판단
    await pauseListing(ctx, l, `장기 판매불가(${s.prune.stalePausedDays}일 넘게 중지) — ${l.status_reason ?? ''}`.slice(0, 300), true);
    out.retired++;
    titles.push(`• ${l.title.slice(0, 28)}`);
  }
  if (out.retired) await ctx.notifications.notify('info', `장기 판매불가 상품 ${out.retired}개 판매종료`, `${titles.slice(0, 8).join('\n')}\n다음 선정 주기에 새 상품으로 교체됩니다. 다시 팔려면 관리 화면 [판매재개].`, { path: '/listings' });
  return out;
}
