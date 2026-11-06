import { afterEach, describe, expect, it } from 'vitest';
import { pauseListing } from '../src/modules/listing/control.js';
import { checkOrderability, reconcileMarketState, retireStalePaused } from '../src/modules/monitor/service.js';
import { pickReplaceable } from '../src/modules/monitor/prune.js';
import { pollNewOrders, processPending } from '../src/modules/orders/service.js';
import { sendDailyReport } from '../src/modules/reports/service.js';
import { listedBefore, runSelection } from '../src/modules/selection/service.js';
import { reviewSlowListings, syncListings } from '../src/modules/sync/service.js';
import { makeHarness, orderByBox, seedActiveListing, type TestHarness, logged } from './helpers.js';

let h: TestHarness;
afterEach(async () => h && (await h.close()));

const COUPANG = { vendorUserId: 'w', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588-0000', returnZipCode: '04524', returnAddress: '서울 중구 세종대로 110', returnAddressDetail: '1층' };
const DAY = 24 * 60;

/** 실제 쿠팡 상품(모의 등록 아님) */
async function seedReal(opts: Parameters<typeof seedActiveListing>[1] = {}) {
  const x = await seedActiveListing(h, opts);
  await h.ctx.db.updateTable('listings').set({ dry_run: false }).where('id', '=', x.listing.id).execute();
  return { ...x, listing: { ...x.listing, dry_run: false } };
}

/** 주문 수집만(발주 전) + 상품 연결·예상이익 지정 */
async function addOrder(x: { listing: { id: number }; vendorItemId: string }, expectedProfit = 3000, status?: string) {
  const line = h.market.seedOrder({ vendorItemId: x.vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
  await pollNewOrders(h.ctx);
  await h.ctx.db.updateTable('orders').set({ listing_id: x.listing.id, expected_profit: expectedProfit, ...(status ? { status } : {}) }).where('shipment_box_id', '=', line.shipmentBoxId).execute();
  return orderByBox(h, line.shipmentBoxId);
}

const listingOf = (id: number) => h.ctx.db.selectFrom('listings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

/** 옵션 2개(빨강·파랑) 상품을 '빨강'으로 올린 상태 */
async function seedOptionListing() {
  const seeded = await seedActiveListing(h, { price: 15000, salePrice: 30000 });
  const p = h.apiSource.products.get(seeded.d.sourceItemId)!;
  p.options = [{ name: '빨강', price: 15000, stock: 20 }, { name: '파랑', price: 14000, stock: 30 }];
  p.defaultOption = '빨강';
  await h.ctx.db.updateTable('listings').set({ source_option: '빨강' }).where('id', '=', seeded.listing.id).execute();
  return { ...seeded, p };
}

describe('판매 가능 감시(동기화)', () => {
  it('올린 옵션이 품절이면 다른 옵션으로 바꾸지 않고 판매중지, 재입고 시 재개 · 발주도 올린 옵션으로', async () => {
    h = await makeHarness({ live: true });
    const { listing, p, vendorItemId } = await seedOptionListing();
    p.options![0]!.stock = 0; // 빨강 품절(파랑은 재고 있음)
    let r = await syncListings(h.ctx);
    expect(r.paused).toBe(1);
    let l = await listingOf(listing.id);
    expect(l.status).toBe('paused');
    expect(l.status_reason).toContain('공급처 품절');
    expect(h.market.items.get(vendorItemId)!.onSale).toBe(false);
    expect(l.paused_at).not.toBeNull();
    // 재입고 → 재개, 판매 재개 알림
    p.options![0]!.stock = 15;
    r = await syncListings(h.ctx);
    expect(r.resumed).toBe(1);
    l = await listingOf(listing.id);
    expect(l.status).toBe('active');
    expect(l.paused_at).toBeNull();
    expect((await logged(h.ctx)).map((x) => x.title)).toContain('상품 1개 판매 재개');
    // 주문 → 올린 옵션(빨강)으로 발주
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    const o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('PURCHASED');
    expect([...h.apiSource.orders.values()][0]!.req.option).toBe('빨강');
  });

  it('올린 옵션이 공급처에서 없어지면 판매 불가로 중지(사유 표시)', async () => {
    h = await makeHarness({ live: true });
    const { listing, p } = await seedOptionListing();
    p.options = [{ name: '파랑', price: 14000, stock: 30 }];
    await syncListings(h.ctx);
    const l = await listingOf(listing.id);
    expect(l.status).toBe('paused');
    expect(l.status_reason).toContain('공급처 판매 불가');
    expect(l.status_reason).toContain('빨강');
    const msg = (await logged(h.ctx)).find((m) => m.title === '상품 1개 자동 판매중지')!;
    expect(msg.body).toContain('빨강');
  });

  it('품절 옵션 주문이 들어오면 발주하지 않고 OUT_OF_STOCK + 판매중지', async () => {
    h = await makeHarness({ live: true });
    const { listing, p, vendorItemId } = await seedOptionListing();
    p.options![0]!.stock = 0;
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('OUT_OF_STOCK');
    expect(h.apiSource.orders.size).toBe(0); // 파랑으로 대신 발주하지 않음
    expect((await listingOf(listing.id)).status).toBe('paused');
  });

  it('오픈마켓 판매 금지로 바뀌면 중지, 다시 허용되면 재개', async () => {
    h = await makeHarness({ live: true });
    const { listing, d } = await seedActiveListing(h);
    h.apiSource.products.get(d.sourceItemId)!.marketSellable = false;
    await syncListings(h.ctx);
    let l = await listingOf(listing.id);
    expect(l.status).toBe('paused');
    expect(l.status_reason).toContain('오픈마켓 판매 금지');
    h.apiSource.products.get(d.sourceItemId)!.marketSellable = true;
    await syncListings(h.ctx);
    l = await listingOf(listing.id);
    expect(l.status).toBe('active');
  });

  it('공급처 재고가 기준(3개) 미만이면 중지, 다시 쌓이면 재개 · 공급처에서 상품 삭제도 중지', async () => {
    h = await makeHarness({ live: true });
    const a = await seedActiveListing(h, { stock: 2 });
    const b = await seedActiveListing(h);
    h.apiSource.products.delete(b.d.sourceItemId);
    const r = await syncListings(h.ctx);
    expect(r.paused).toBe(2);
    expect((await listingOf(a.listing.id)).status_reason).toContain('공급처 재고 부족: 재고 2개');
    expect((await listingOf(b.listing.id)).status_reason).toContain('공급처에서 상품이 삭제됨');
    h.apiSource.products.get(a.d.sourceItemId)!.stock = 10;
    await syncListings(h.ctx);
    expect((await listingOf(a.listing.id)).status).toBe('active');
    expect((await listingOf(b.listing.id)).status).toBe('paused');
  });

  it('최저판매준수가가 생기면 가격을 올리고, 가드로 못 맞추면 판매중지', async () => {
    h = await makeHarness({ live: true });
    const ok = await seedActiveListing(h, { salePrice: 30000 });
    const ng = await seedActiveListing(h, { salePrice: 30000 });
    h.apiSource.products.get(ok.d.sourceItemId)!.minResalePrice = 36000; // +20%: 가드 범위
    h.apiSource.products.get(ng.d.sourceItemId)!.minResalePrice = 60000; // +100%: 가드(+50%) 초과
    await syncListings(h.ctx);
    const a = await listingOf(ok.listing.id);
    expect(a.status).toBe('active');
    expect(a.sale_price).toBeGreaterThanOrEqual(36000);
    const b = await listingOf(ng.listing.id);
    expect(b.status).toBe('paused');
    expect(b.status_reason).toContain('최저판매준수가 미달');
  });

  it('이 상품만 조회가 계속 실패하면 확인 불가로 중지 — 공급처 전체 장애면 중지하지 않음', async () => {
    h = await makeHarness({ live: true });
    const a = await seedActiveListing(h);
    const b = await seedActiveListing(h);
    h.apiSource.failProduct.set(a.d.sourceItemId, 100);
    for (let i = 0; i < 5; i++) await syncListings(h.ctx);
    expect((await listingOf(a.listing.id)).status).toBe('active'); // 5회: 아직
    expect((await listingOf(a.listing.id)).check_fails).toBe(5);
    await syncListings(h.ctx);
    const l = await listingOf(a.listing.id);
    expect(l.status).toBe('paused');
    expect(l.status_reason).toContain('공급처 확인 불가');
    expect((await listingOf(b.listing.id)).status).toBe('active');
    expect((await listingOf(b.listing.id)).checked_at).not.toBeNull();
    // 조회가 회복되면 재개
    h.apiSource.failProduct.set(a.d.sourceItemId, 0);
    await syncListings(h.ctx);
    expect((await listingOf(a.listing.id)).status).toBe('active');
    expect((await listingOf(a.listing.id)).check_fails).toBe(0);

    // 공급처 전체 장애(모든 상품 실패) → 아무것도 멈추지 않음
    h.apiSource.failNext.set('getProduct', 1000);
    for (let i = 0; i < 8; i++) await syncListings(h.ctx);
    expect((await listingOf(a.listing.id)).status).toBe('active');
    expect((await listingOf(b.listing.id)).status).toBe('active');
  });

  it('사람이 멈춘 상품·쿠팡에서 멈춘 상품은 공급처가 정상이어도 자동 재개하지 않음', async () => {
    h = await makeHarness({ live: true });
    const a = await seedActiveListing(h);
    await pauseListing(h.ctx, a.listing, '관리자 중지');
    const b = await seedActiveListing(h);
    await h.ctx.db.updateTable('listings').set({ status: 'paused', status_reason: '쿠팡에서 판매중지됨(Wing 또는 쿠팡 조치)' }).where('id', '=', b.listing.id).execute();
    const r = await syncListings(h.ctx);
    expect(r.resumed).toBe(0);
    expect((await listingOf(a.listing.id)).status).toBe('paused');
    expect((await listingOf(b.listing.id)).status).toBe('paused');
  });
});

describe('주문 가능 점검(공급처 주문 시뮬레이션)', () => {
  it('반품지 주소가 없으면 점검하지 않음(고객 정보는 쓰지 않음)', async () => {
    h = await makeHarness({ live: true });
    await seedActiveListing(h);
    const r = await checkOrderability(h.ctx);
    expect(r.skipped).toContain('반품지');
    expect(h.apiSource.orderChecks).toHaveLength(0);
  });

  it('공급처가 거부하면 주문 불가로 중지 → 동기화는 재개하지 않음 → 다음 점검 통과 시 재개 · 점검 간격 준수', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ coupang: COUPANG });
    const { listing, d, vendorItemId } = await seedOptionListing();
    h.apiSource.orderCheck.set(d.sourceItemId, { ok: false, definitive: true, reason: '옵션 정보가 올바르지 않습니다' });
    let r = await checkOrderability(h.ctx);
    expect(r).toMatchObject({ checked: 1, paused: 1 });
    const req = h.apiSource.orderChecks[0]!;
    expect(req).toMatchObject({ option: '빨강', qty: 1 });
    expect(req.receiver).toMatchObject({ addr1: COUPANG.returnAddress, zip: COUPANG.returnZipCode }); // 우리 반품지
    let l = await listingOf(listing.id);
    expect(l.status).toBe('paused');
    expect(l.status_reason).toContain('주문 불가');
    expect(h.market.items.get(vendorItemId)!.onSale).toBe(false);
    expect((await logged(h.ctx)).map((x) => x.title)).toContain('주문 불가 상품 1개 판매중지');
    // 공급처 상품 자체는 정상 → 동기화가 재개하면 안 됨
    await syncListings(h.ctx);
    expect((await listingOf(listing.id)).status).toBe('paused');
    // 간격 안: 다시 점검 안 함
    h.apiSource.orderCheck.delete(d.sourceItemId);
    r = await checkOrderability(h.ctx);
    expect(r.checked).toBe(0);
    // 24시간 뒤 통과 → 재개
    h.clock.advanceMinutes(DAY + 1);
    r = await checkOrderability(h.ctx);
    expect(r).toMatchObject({ checked: 1, ok: 1, resumed: 1 });
    l = await listingOf(listing.id);
    expect(l.status).toBe('active');
    expect(h.market.items.get(vendorItemId)!.onSale).toBe(true);
  });

  it('일시 오류는 멈추지 않고 다음 실행에 다시 점검', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ coupang: COUPANG });
    const { listing, d } = await seedActiveListing(h);
    h.apiSource.orderCheck.set(d.sourceItemId, { ok: false, definitive: false, reason: '오너클랜 호출 한도 초과' });
    let r = await checkOrderability(h.ctx);
    expect(r).toMatchObject({ checked: 1, transient: 1, paused: 0 });
    expect((await listingOf(listing.id)).order_checked_at).toBeNull();
    h.apiSource.orderCheck.delete(d.sourceItemId);
    r = await checkOrderability(h.ctx);
    expect(r).toMatchObject({ checked: 1, ok: 1 });
    expect((await listingOf(listing.id)).order_checked_at).not.toBeNull();
  });

  it('실주문 금액 기준 손실이면 중지, 이익은 남지만 비싸지면 알림만', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ coupang: COUPANG });
    const loss = await seedActiveListing(h, { salePrice: 30000 });
    const pricier = await seedActiveListing(h, { salePrice: 30000 });
    h.apiSource.orderCheck.set(loss.d.sourceItemId, { ok: true, cost: 26000, shippingCost: 3000 });
    h.apiSource.orderCheck.set(pricier.d.sourceItemId, { ok: true, cost: 16000, shippingCost: 3000 });
    const r = await checkOrderability(h.ctx);
    expect(r).toMatchObject({ checked: 2, paused: 1, ok: 1 });
    const l = await listingOf(loss.listing.id);
    expect(l.status).toBe('paused');
    expect(l.status_reason).toContain('실주문 금액 29,000원 기준 손실');
    expect((await listingOf(pricier.listing.id)).status).toBe('active');
    expect((await logged(h.ctx)).map((x) => x.title)).toContain('실주문 금액이 예상보다 비싼 상품');
  });

  it('한 번에 다수가 거부되면 연동 문제로 보고 멈추지 않음(알림)', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ coupang: COUPANG });
    const rows = [await seedActiveListing(h), await seedActiveListing(h), await seedActiveListing(h)];
    for (const x of rows) h.apiSource.orderCheck.set(x.d.sourceItemId, { ok: false, definitive: true, reason: 'Cannot query field' });
    const r = await checkOrderability(h.ctx);
    expect(r).toMatchObject({ checked: 3, paused: 0, systemic: true });
    for (const x of rows) expect((await listingOf(x.listing.id)).status).toBe('active');
    expect(h.notifier.titles()).toContain('주문 가능 점검: 연동 문제 의심');
  });

  it('한 번에 점검하는 수 제한(simulatePerRun), 오래된 점검부터', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ coupang: COUPANG, monitor: { simulatePerRun: 2 } });
    for (let i = 0; i < 3; i++) await seedActiveListing(h);
    expect((await checkOrderability(h.ctx)).checked).toBe(2);
    expect((await checkOrderability(h.ctx)).checked).toBe(1);
    expect((await checkOrderability(h.ctx)).checked).toBe(0);
  });
});

describe('쿠팡 판매상태 대조', () => {
  it('우리가 멈춘 상품이 쿠팡에서 판매중이면 다시 중지, 쿠팡에서 멈춘 상품은 기록하고 자동 재개 안 함, Wing에서 재개하면 반영', async () => {
    h = await makeHarness({ live: true });
    const a = await seedReal();
    h.apiSource.products.get(a.d.sourceItemId)!.status = 'soldout';
    await syncListings(h.ctx);
    h.market.items.get(a.vendorItemId)!.onSale = true; // 판매중지가 반영 안 된 상태
    const b = await seedReal();
    h.market.items.get(b.vendorItemId)!.onSale = false; // Wing에서 직접 중지
    let r = await reconcileMarketState(h.ctx);
    expect(r).toMatchObject({ checked: 2, restopped: 1, marketStopped: 1 });
    expect(h.market.items.get(a.vendorItemId)!.onSale).toBe(false);
    const lb = await listingOf(b.listing.id);
    expect(lb.status).toBe('paused');
    expect(lb.status_reason).toContain('쿠팡에서 판매중지됨');
    await syncListings(h.ctx);
    expect((await listingOf(b.listing.id)).status).toBe('paused'); // 자동 재개 안 함
    // 사람이 Wing에서 다시 판매 → 따름
    h.market.items.get(b.vendorItemId)!.onSale = true;
    r = await reconcileMarketState(h.ctx);
    expect((await listingOf(b.listing.id)).status).toBe('active');
    expect(h.market.items.get(b.vendorItemId)!.onSale).toBe(true);
    expect((await logged(h.ctx)).map((x) => x.title)).toContain('Wing에서 판매 재개한 상품 1개 반영');
  });

  it('모의 등록 상품은 대조하지 않음, 조회 실패는 건너뜀', async () => {
    h = await makeHarness({ live: true });
    const a = await seedReal();
    await h.ctx.db.updateTable('listings').set({ dry_run: true }).where('id', '=', a.listing.id).execute();
    h.market.items.get(a.vendorItemId)!.onSale = false;
    const b = await seedReal();
    h.market.failNext.set('getItemSaleState', 1);
    const r = await reconcileMarketState(h.ctx);
    expect(r).toMatchObject({ checked: 1, errors: 1, marketStopped: 0 });
    expect(h.notifier.titles()).toContain('쿠팡 판매상태 조회 실패'); // 전부 실패 → 대조 불가 알림
    expect((await listingOf(a.listing.id)).status).toBe('active');
    expect((await listingOf(b.listing.id)).status).toBe('active');
  });

  it('DRY_RUN(실등록·가격 반영 꺼짐)에서는 실제로 멈출 수 없어 다시 중지 알림을 내지 않음', async () => {
    h = await makeHarness({ live: false });
    const a = await seedActiveListing(h);
    await h.ctx.db.updateTable('listings').set({ dry_run: false, status: 'paused', status_reason: '공급처 품절' }).where('id', '=', a.listing.id).execute();
    const r = await reconcileMarketState(h.ctx);
    expect(r.restopped).toBe(0);
    expect(h.notifier.titles().some((t) => t.includes('다시 중지'))).toBe(false);
  });
});

describe('판매 상품 정리', () => {
  it('품절·주문 불가로 오래 멈춘 상품은 판매종료, 사람이 멈춘 상품은 그대로 · 종료한 상품은 다시 후보로 올리지 않음', async () => {
    h = await makeHarness({ live: true });
    const a = await seedReal();
    const b = await seedActiveListing(h);
    h.apiSource.products.get(a.d.sourceItemId)!.status = 'soldout';
    await syncListings(h.ctx);
    await pauseListing(h.ctx, b.listing, '관리자 중지');
    h.clock.advanceMinutes(13 * DAY);
    await syncListings(h.ctx); // 계속 품절 — 중지 시각은 처음 그대로
    expect((await retireStalePaused(h.ctx)).retired).toBe(0);
    h.clock.advanceMinutes(2 * DAY);
    expect((await retireStalePaused(h.ctx)).retired).toBe(1);
    const la = await listingOf(a.listing.id);
    expect(la.status).toBe('stopped');
    expect(la.status_reason).toContain('장기 판매불가');
    expect((await listingOf(b.listing.id)).status).toBe('paused');
    // 실제로 올렸다 정리한 상품 → 다시 후보 금지(쿠팡 중복 등록 방지)
    expect(await listedBefore(h.ctx, 'mockapi', a.d.sourceItemId)).toBe(true);
    // 모의 등록분 정리는 다시 가능
    await h.ctx.db.updateTable('listings').set({ dry_run: true }).where('id', '=', a.listing.id).execute();
    expect(await listedBefore(h.ctx, 'mockapi', a.d.sourceItemId)).toBe(false);
  });

  it('판매 부진: 취소 주문은 판매로 치지 않음, 다시 팔리면 하한가 시험 이력 초기화', async () => {
    h = await makeHarness({ live: true });
    const { listing, vendorItemId } = await seedActiveListing(h, { salePrice: 30000, markup: 0.3 });
    h.clock.advanceMinutes(15 * DAY);
    const o = await addOrder({ listing, vendorItemId }, 3000, 'CANCELLED');
    expect((await reviewSlowListings(h.ctx)).lowered).toBe(1); // 취소 1건 = 판매 0
    expect((await listingOf(listing.id)).zero_sale_adjusted).toBe(true);
    await h.ctx.db.updateTable('orders').set({ status: 'DELIVERED' }).where('id', '=', o.id).execute();
    await reviewSlowListings(h.ctx);
    expect((await listingOf(listing.id)).zero_sale_adjusted).toBe(false);
  });

  it('상한일 때 실적이 쌓인 저성과 상품만 교체 대상(출시 보호·이익 상품 보호·기대이익 차이 필요)', async () => {
    h = await makeHarness({ live: true });
    const old = new Date(h.clock.now().getTime() - 40 * 86400_000);
    const young = await seedReal(); // 최근 등록 → 보호
    const weak = await seedReal();
    const strong = await seedReal();
    await h.ctx.db.updateTable('listings').set({ listed_at: old }).where('id', 'in', [weak.listing.id, strong.listing.id]).execute();
    // weak: 30일 주문 1건(이익 4,000), strong: 이익 40,000
    await addOrder(weak, 4000);
    await addOrder(strong, 40000);
    expect(await pickReplaceable(h.ctx, 9000)).toBeNull(); // 최소 기대이익(1만원) 미만
    expect(await pickReplaceable(h.ctx, 7000 + 3000)).toMatchObject({ listing: { id: weak.listing.id }, monthlyProfit: 4000, orders: 1 });
    await h.ctx.settings.update({ prune: { replaceMinGainKrw: 1000 } });
    expect(await pickReplaceable(h.ctx, 7000)).toBeNull(); // 4,000 × 2배 = 8,000 미만
    expect((await pickReplaceable(h.ctx, 100000))!.listing.id).toBe(weak.listing.id); // strong(3만원 이상)·young 은 대상 아님
    expect(await pickReplaceable(h.ctx, 100000, [weak.listing.id])).toBeNull();
    expect(young.listing.id).toBeGreaterThan(0);
  });

  it('선정: 상한이 차면 저성과 상품을 판매종료하고 새 후보 등록(1회 최대 교체 수), 교체할 상품 없으면 건너뜀', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({
      coupang: COUPANG,
      listing: { maxActiveListings: 2 },
      selection: { autoListPerRun: 5, maxPerKeyword: 5 },
      prune: { replaceMinGainKrw: 1, maxReplacePerRun: 1 },
    });
    const old = new Date(h.clock.now().getTime() - 40 * 86400_000);
    const a = await seedActiveListing(h);
    const b = await seedActiveListing(h);
    await h.ctx.db.updateTable('listings').set({ listed_at: old, dry_run: false }).where('id', 'in', [a.listing.id, b.listing.id]).execute();
    h.marketData.volume.set('정리함', 20000);
    h.apiSource.add({ sourceItemId: 'N1', title: '스텐 수납 정리함', price: 16000 });
    h.apiSource.add({ sourceItemId: 'N2', title: '원목 서랍 정리함', price: 17000 });
    const r = await runSelection(h.ctx, { keywords: ['정리함'] });
    expect(r.autoListed).toBe(1); // 교체 1개만
    const stopped = (await h.ctx.db.selectFrom('listings').selectAll().where('status', '=', 'stopped').execute());
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.status_reason).toContain('우선순위 밀림');
    expect(h.market.items.get(stopped[0]!.vendor_item_id!)!.onSale).toBe(false);
    const msg = (await logged(h.ctx)).find((x) => x.title.startsWith('상품 선정 결과'))!;
    expect(msg.body).toContain('우선순위 교체 1개');
    expect(msg.body).toContain('1회 교체 한도(1개) 도달');
    // 남은 운영 상품 수는 상한 그대로
    const live = await h.ctx.db.selectFrom('listings').select('id').where('status', 'in', ['active', 'pending_approval']).execute();
    expect(live).toHaveLength(2);
  });

  it('상한인데 운영 기간이 짧은 상품뿐이면 교체하지 않음', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ coupang: COUPANG, listing: { maxActiveListings: 1 }, prune: { replaceMinGainKrw: 1 } });
    const a = await seedReal(); // 오늘 등록
    h.marketData.volume.set('정리함', 20000);
    h.apiSource.add({ sourceItemId: 'N1', title: '스텐 수납 정리함', price: 16000 });
    const r = await runSelection(h.ctx, { keywords: ['정리함'] });
    expect(r.autoListed).toBe(0);
    expect((await listingOf(a.listing.id)).status).toBe('active');
    expect(await h.ctx.db.selectFrom('listings').select('id').where('status', '=', 'draft').execute()).toHaveLength(0); // 초안도 안 만듦
    expect((await logged(h.ctx)).find((x) => x.title.startsWith('상품 선정 결과'))!.body).toContain('교체할 저성과 상품 없음');
  });

  it('교체 중 새 상품 등록이 실패하면 기존 상품을 되살림', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ coupang: COUPANG, listing: { maxActiveListings: 1 }, prune: { replaceMinGainKrw: 1 } });
    const a = await seedActiveListing(h);
    await h.ctx.db.updateTable('listings').set({ listed_at: new Date(h.clock.now().getTime() - 40 * 86400_000), dry_run: false }).where('id', '=', a.listing.id).execute();
    h.marketData.volume.set('정리함', 20000);
    h.apiSource.add({ sourceItemId: 'N1', title: '스텐 수납 정리함', price: 16000 });
    h.market.failNext.set('createProduct', 1);
    const r = await runSelection(h.ctx, { keywords: ['정리함'] });
    expect(r.autoListed).toBe(0);
    const l = await listingOf(a.listing.id);
    expect(l.status).toBe('active');
    expect(h.market.items.get(a.vendorItemId)!.onSale).toBe(true);
  });
});

describe('마이그레이션', () => {
  it('006: 운영 중 상품의 발주 옵션을 공급처 스냅샷의 기본 옵션으로 채움(종료 상품 제외), 일시중지 시각 채움', async () => {
    h = await makeHarness({ live: true });
    const a = await seedOptionListing();
    const b = await seedActiveListing(h);
    const c = await seedOptionListing();
    const { upsertSourceProduct } = await import('../src/modules/catalog.js');
    await upsertSourceProduct(h.ctx, 'mockapi', a.p); // detail.defaultOption = '빨강'
    await upsertSourceProduct(h.ctx, 'mockapi', c.p);
    await h.ctx.db.updateTable('listings').set({ status: 'stopped' }).where('id', '=', c.listing.id).execute();
    await h.ctx.db.updateTable('listings').set({ status: 'paused' }).where('id', '=', b.listing.id).execute();
    const m = await import('../src/db/migrations/006_monitor.js');
    await m.down(h.ctx.db as never);
    await m.up(h.ctx.db as never);
    expect((await listingOf(a.listing.id)).source_option).toBe('빨강');
    expect((await listingOf(b.listing.id)).source_option).toBeNull(); // 옵션 없는 상품
    expect((await listingOf(c.listing.id)).source_option).toBeNull(); // 종료 상품은 건드리지 않음
    expect((await listingOf(b.listing.id)).paused_at).not.toBeNull();
    expect((await listingOf(a.listing.id)).check_fails).toBe(0);
  });
});

describe('리포트', () => {
  it('일일 리포트에 일시중지 사유·공급처 확인 밀림 표시', async () => {
    h = await makeHarness({ live: true });
    const a = await seedActiveListing(h);
    h.apiSource.products.get(a.d.sourceItemId)!.status = 'soldout';
    await syncListings(h.ctx);
    await seedActiveListing(h); // 확인 전
    h.clock.advanceMinutes(5 * 60);
    await sendDailyReport(h.ctx);
    const body = h.notifier.sent.at(-1)!.body;
    expect(body).toContain('일시중지 사유: 공급처 품절·판매불가 1');
    expect(body).toContain('공급처 확인이 밀린 판매중 상품 1개');
  });
});
