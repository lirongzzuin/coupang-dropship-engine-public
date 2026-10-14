import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/config/settings.js';
import { markWinner, planWinner, respondToWinner, winnerCap } from '../src/modules/listing/winner.js';
import { reconcileMarketState } from '../src/modules/monitor/service.js';
import { sendDailyReport } from '../src/modules/reports/service.js';
import { listedBefore } from '../src/modules/selection/service.js';
import { syncListings } from '../src/modules/sync/service.js';
import { makeHarness, seedActiveListing, type TestHarness } from './helpers.js';

let h: TestHarness;
afterEach(async () => h && (await h.close()));
const DAY = 24 * 60;
const listingOf = (id: number) => h.ctx.db.selectFrom('listings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

/** 실제 쿠팡 상품(판매가 30,000 · 하한가 22,000) + 선정 키워드 */
async function seedReal(opts: Parameters<typeof seedActiveListing>[1] = {}) {
  const x = await seedActiveListing(h, opts);
  const cand = await h.ctx.db.insertInto('candidates').values({ source_product_id: x.listing.source_product_id, keyword: '수납 정리함', score: 0.5, signals: '{}', gates: '[]', passed: true, run_id: 'r0', status: 'listed', created_at: h.clock.now() }).returning('id').executeTakeFirstOrThrow();
  await h.ctx.db.updateTable('listings').set({ dry_run: false, candidate_id: cand.id }).where('id', '=', x.listing.id).execute();
  return x;
}

describe('아이템위너 계획(순수 계산)', () => {
  const s = defaultSettings();
  it('위너보다 10원 싸게(10원 단위·끝자리 올림 없음), 하한가 아래면 판매종료, 이미 싸면 유지', () => {
    expect(planWinner(s, { current: 30000, floor: 22000, winnerTotal: 27000, changesToday: 0 })).toMatchObject({ action: 'reprice', price: 26990, partial: false });
    expect(planWinner(s, { current: 30000, floor: 22000, winnerTotal: 27005, changesToday: 0 })).toMatchObject({ action: 'reprice', price: 26990 });
    expect(planWinner(s, { current: 30000, floor: 22000, winnerTotal: 23000, changesToday: 0 })).toMatchObject({ action: 'reprice', price: 24000, partial: true, target: 22990 }); // 1회 −20%
    expect(planWinner(s, { current: 30000, floor: 22000, winnerTotal: 22005, changesToday: 0 })).toMatchObject({ action: 'stop', target: 21990 });
    expect(planWinner(s, { current: 25000, floor: 22000, winnerTotal: 26000, changesToday: 0 })).toMatchObject({ action: 'keep', price: 25000 });
    expect(planWinner(s, { current: 30000, floor: 22000, winnerTotal: 27000, changesToday: 2 })).toMatchObject({ action: 'reprice', price: 30000, partial: true }); // 오늘 횟수 소진
  });

  it('위너 가격 상한은 위너 아님 + 유효기간 안에서만', () => {
    const now = new Date('2026-10-14T00:00:00Z');
    expect(winnerCap(s, { winner_status: 'not_winner', winner_price: 27000, winner_checked_at: now }, now)).toBe(26990);
    expect(winnerCap(s, { winner_status: 'winner', winner_price: 27000, winner_checked_at: now }, now)).toBeNull();
    expect(winnerCap(s, { winner_status: 'not_winner', winner_price: 27000, winner_checked_at: now }, new Date(now.getTime() + 31 * 86400_000))).toBeNull();
    expect(winnerCap(s, { winner_status: null, winner_price: null, winner_checked_at: null }, now)).toBeNull();
  });
});

describe('아이템위너 대응(관리 화면)', () => {
  it('미리보기는 아무것도 바꾸지 않음 → 적용하면 쿠팡 가격을 위너 −10원으로, 위너 가격·쿠팡 최저가 기록', async () => {
    h = await makeHarness({ live: true });
    const { listing, vendorItemId } = await seedReal();
    const preview = await respondToWinner(h.ctx, listing.id, 27000, false, 'admin');
    expect(preview).toMatchObject({ action: 'reprice', price: 26990, applied: false });
    expect(h.market.items.get(vendorItemId)!.price).toBe(30000);
    expect((await listingOf(listing.id)).winner_status).toBeNull();

    const r = await respondToWinner(h.ctx, listing.id, 27000, true, 'admin');
    expect(r).toMatchObject({ action: 'reprice', applied: true, listingStatus: 'active' });
    expect(h.market.items.get(vendorItemId)!.price).toBe(26990);
    const l = await listingOf(listing.id);
    expect(l).toMatchObject({ sale_price: 26990, winner_status: 'not_winner', winner_price: 27000 });
    expect(l.markup).toBeCloseTo(26990 / 22000 - 1, 5);
    const sig = await h.ctx.db.selectFrom('market_signals').selectAll().where('keyword', '=', '수납 정리함').where('kind', '=', 'coupang_lowest').executeTakeFirstOrThrow();
    expect(sig.value).toBe(27000);
    const pc = await h.ctx.db.selectFrom('price_changes').selectAll().where('listing_id', '=', listing.id).execute();
    expect(pc.at(-1)).toMatchObject({ old_price: 30000, new_price: 26990 });
  });

  it('위너보다 싸게 팔면 손실 → 판매종료(쿠팡 판매중지), 다시 후보로 올리지 않음', async () => {
    h = await makeHarness({ live: true });
    const { listing, vendorItemId, d } = await seedReal();
    const r = await respondToWinner(h.ctx, listing.id, 21000, true, 'admin');
    expect(r).toMatchObject({ action: 'stop', listingStatus: 'stopped' });
    const l = await listingOf(listing.id);
    expect(l.status).toBe('stopped');
    expect(l.status_reason).toContain('아이템위너 경쟁 불가');
    expect(h.market.items.get(vendorItemId)!.onSale).toBe(false);
    expect(await listedBefore(h.ctx, 'mockapi', d.sourceItemId)).toBe(true);
  });

  it('한 번에 못 내린 만큼은 다음 날 동기화가 이어서 위너 아래로', async () => {
    h = await makeHarness({ live: true });
    const { listing, vendorItemId } = await seedReal();
    expect(await respondToWinner(h.ctx, listing.id, 23000, true, 'admin')).toMatchObject({ price: 24000, partial: true });
    expect(h.market.items.get(vendorItemId)!.price).toBe(24000);
    h.clock.advanceMinutes(DAY);
    await syncListings(h.ctx);
    expect(h.market.items.get(vendorItemId)!.price).toBe(22990);
    expect((await listingOf(listing.id)).sale_price).toBe(22990);
  });

  it('원가가 올라 판매가를 다시 계산해도 위너 가격 위로 올리지 않음, 하한가가 위너보다 높아지면 손실 없이 하한가 + 알림', async () => {
    h = await makeHarness({ live: true });
    const { listing, vendorItemId, d } = await seedReal({ markup: 0.3 });
    await respondToWinner(h.ctx, listing.id, 27000, true, 'admin');
    h.clock.advanceMinutes(DAY);
    h.apiSource.products.get(d.sourceItemId)!.price = 15500; // 원가 소폭 상승 → 재계산(마크업 30%면 3만원대)
    await syncListings(h.ctx);
    expect(h.market.items.get(vendorItemId)!.price).toBeLessThanOrEqual(26990);
    // 원가 급등 → 하한가 > 위너 → 하한가로(손실 판매 금지) + 알림
    h.clock.advanceMinutes(DAY);
    h.apiSource.products.get(d.sourceItemId)!.price = 21000;
    await syncListings(h.ctx);
    const l = await listingOf(listing.id);
    expect(l.sale_price).toBeGreaterThanOrEqual(l.floor_price);
    expect(l.floor_price).toBeGreaterThan(26990);
    expect(h.notifier.titles()).toContain('아이템위너 가격 아래로 내릴 수 없음');
  });

  it('[위너 맞음]은 상한을 풀고 기록만', async () => {
    h = await makeHarness({ live: true });
    const { listing } = await seedReal();
    await respondToWinner(h.ctx, listing.id, 27000, true, 'admin');
    await markWinner(h.ctx, listing.id, 'admin');
    const l = await listingOf(listing.id);
    expect(l).toMatchObject({ winner_status: 'winner', winner_price: null });
    expect(winnerCap(await h.ctx.settings.get(), l, h.clock.now())).toBeNull();
  });

  it('판매중·일시중지 상품만, 가격 0 은 거부', async () => {
    h = await makeHarness({ live: true });
    const { listing } = await seedReal();
    await expect(respondToWinner(h.ctx, listing.id, 0, false, 'admin')).rejects.toThrow(/위너 가격/);
    await h.ctx.db.updateTable('listings').set({ status: 'stopped' }).where('id', '=', listing.id).execute();
    await expect(respondToWinner(h.ctx, listing.id, 27000, false, 'admin')).rejects.toThrow(/판매중/);
  });
});

describe('쿠팡(Wing)에서 바꾼 가격 반영', () => {
  it('같은 다른 가격이 두 번 연속 보이면 반영(한 번은 반영 지연일 수 있음)', async () => {
    h = await makeHarness({ live: true });
    const { listing, vendorItemId } = await seedReal();
    h.market.items.get(vendorItemId)!.price = 28000; // 사람이 Wing에서 변경
    await reconcileMarketState(h.ctx);
    expect((await listingOf(listing.id)).sale_price).toBe(30000);
    h.clock.advanceMinutes(60);
    const r = await reconcileMarketState(h.ctx);
    expect(r.priceAdopted).toBe(1);
    const l = await listingOf(listing.id);
    expect(l.sale_price).toBe(28000);
    expect(l.status).toBe('active');
    expect(h.notifier.titles()).toContain('쿠팡(Wing)에서 바뀐 가격 1개 반영');
  });

  it('최근 3시간 안에 우리가 바꾼 가격은 반영 지연으로 보고 건너뜀', async () => {
    h = await makeHarness({ live: true });
    const { listing, vendorItemId } = await seedReal();
    await h.ctx.db.updateTable('listings').set({ price_set_at: h.clock.now() }).where('id', '=', listing.id).execute();
    h.market.items.get(vendorItemId)!.price = 28000;
    await reconcileMarketState(h.ctx);
    h.clock.advanceMinutes(60);
    await reconcileMarketState(h.ctx);
    expect((await listingOf(listing.id)).sale_price).toBe(30000);
  });

  it('손실 가격이면 판매중지 → 동기화가 하한가로 올린 뒤 재개', async () => {
    h = await makeHarness({ live: true });
    const { listing, vendorItemId } = await seedReal();
    h.market.items.get(vendorItemId)!.price = 15000;
    await reconcileMarketState(h.ctx);
    h.clock.advanceMinutes(60);
    await reconcileMarketState(h.ctx);
    let l = await listingOf(listing.id);
    expect(l.status).toBe('paused');
    expect(l.status_reason).toContain('마진 역전');
    expect(h.market.items.get(vendorItemId)!.onSale).toBe(false);
    await syncListings(h.ctx);
    l = await listingOf(listing.id);
    expect(l.status).toBe('active'); // 손실 없는 가격으로 올린 뒤 재개(1회 +50% 가드 → 나머지는 다음 날)
    expect(l.sale_price).toBe(22500);
    expect(h.market.items.get(vendorItemId)!.price).toBe(22500);
    h.clock.advanceMinutes(DAY);
    await syncListings(h.ctx);
    l = await listingOf(listing.id);
    expect(l.sale_price).toBeGreaterThanOrEqual(l.floor_price);
  });

  it('설정으로 끌 수 있음', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ itemWinner: { adoptMarketPrice: false } });
    const { listing, vendorItemId } = await seedReal();
    h.market.items.get(vendorItemId)!.price = 28000;
    await reconcileMarketState(h.ctx);
    h.clock.advanceMinutes(60);
    await reconcileMarketState(h.ctx);
    expect((await listingOf(listing.id)).sale_price).toBe(30000);
  });
});

describe('리포트·마이그레이션', () => {
  it('등록 후 2일 지나도 주문 없고 위너 확인 전이면 리포트에 확인 요청(위너 입력 후엔 빠짐)', async () => {
    h = await makeHarness({ live: true });
    const { listing } = await seedReal();
    h.clock.advanceMinutes(3 * DAY);
    await sendDailyReport(h.ctx);
    expect(h.notifier.sent.at(-1)!.body).toContain('아이템위너 확인 필요 1개');
    await markWinner(h.ctx, listing.id, 'admin');
    h.clock.advanceMinutes(DAY);
    await sendDailyReport(h.ctx);
    expect(h.notifier.sent.at(-1)!.body).not.toContain('아이템위너 확인 필요');
  });

  it('007: 기존 상품은 위너 미확인(null) — 동작 변화 없음', async () => {
    h = await makeHarness({ live: true });
    const { listing } = await seedReal();
    const m = await import('../src/db/migrations/007_winner.js');
    await m.down(h.ctx.db as never);
    await m.up(h.ctx.db as never);
    const l = await listingOf(listing.id);
    expect(l).toMatchObject({ winner_status: null, winner_price: null, winner_checked_at: null });
  });
});
