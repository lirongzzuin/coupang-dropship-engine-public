import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings, mergeSettings } from '../src/config/settings.js';
import { reconcile } from '../src/modules/finance/service.js';
import { refreshListingStatuses, registerListing } from '../src/modules/listing/service.js';
import { pollNewOrders, processPending } from '../src/modules/orders/service.js';
import { bundleOptions, charmPrice, initialMarkup, markupCapForMarket, priceFromMarkup, targetPrice } from '../src/modules/pricing/pricing.js';
import { decideCandidate, runSelection } from '../src/modules/selection/service.js';
import { scoreCandidate } from '../src/modules/selection/scoring.js';
import { optimizePrices, scoutCheaperSources } from '../src/modules/sync/service.js';
import { makeHarness, orderByBox, seedActiveListing, type TestHarness } from './helpers.js';

const S = () => mergeSettings(defaultSettings(), { fees: { monthlyServiceFee: 0 } });

describe('가격 함수', () => {
  it('끝자리 900원(항상 원래 가격 이상)', () => {
    const s = S();
    expect(charmPrice(s, 22400)).toBe(22900);
    expect(charmPrice(s, 22900)).toBe(22900);
    expect(charmPrice(s, 22901)).toBe(23900);
    expect(charmPrice(s, 8450)).toBe(8490);
    expect(charmPrice(mergeSettings(s, { pricing: { charmEnding: 'none' } }), 22410)).toBe(22500);
  });
  it('마크업 → 판매가, 상한·하한', () => {
    const s = S();
    expect(priceFromMarkup(s, 20000, 0.1)).toBe(22900);
    expect(priceFromMarkup(s, 20000, 0)).toBe(20900);
    expect(priceFromMarkup(s, 20000, 5)).toBe(priceFromMarkup(s, 20000, s.pricing.maxMarkup)); // 상한
  });
  it('시작 마크업: 경쟁 최저가보다 1% 낮게, 모르면 기본값', () => {
    const s = S();
    expect(initialMarkup(s, 20000, null)).toBe(0.08);
    expect(initialMarkup(s, 20000, 25000)).toBeCloseTo(0.2375, 2); // 25000×0.99/20000 − 1
    expect(initialMarkup(s, 20000, 18000)).toBe(0); // 경쟁가가 하한보다 낮으면 하한가
    expect(markupCapForMarket(s, 20000, 22000)).toBeCloseTo(0.089, 3);
  });
  it('묶음 옵션: 배송비 1회면 2·3개 옵션(개당 하한가↓), 수량별 배송비·박스 한도·재고 제한', () => {
    const s = S();
    const base = { unitCost: 10000, cost: 10000, shipping: 3000, categoryPath: '생활용품', inputVatDeductible: true, stock: 100 };
    const opts = bundleOptions(s, base);
    expect(opts.map((o) => o.units)).toEqual([1, 2, 3]);
    expect(opts[1]!.floor / 2).toBeLessThan(opts[0]!.floor); // 2개 옵션의 개당 가격이 더 낮음
    expect(opts[1]!.floor).toBe(targetPrice(s, { cost: 20000, shipping: 3000, categoryPath: '생활용품', inputVatDeductible: true }).floor);
    expect(bundleOptions(s, { ...base, shippingPerUnit: true }).map((o) => o.units)).toEqual([1]);
    expect(bundleOptions(s, { ...base, maxPerBox: 2 }).map((o) => o.units)).toEqual([1, 2]);
    expect(bundleOptions(s, { ...base, stock: 12 }).map((o) => o.units)).toEqual([1, 2]); // 3개×5=15 > 12
  });
  it('점수: 이익 잠재력(개당 이익 × 검색량)', () => {
    const s = S();
    const d = { sourceItemId: '1', title: 't', url: '', price: 10000, shippingFee: 3000, status: 'active', stock: 100, imageReuseAllowed: true, images: [], taxInvoice: true } as any;
    const tp = targetPrice(s, { cost: 10000, shipping: 3000 });
    const lo = scoreCandidate(s, d, tp, { searchVolume: 500 }, { apiOrder: true });
    const hi = scoreCandidate(s, d, tp, { searchVolume: 50000 }, { apiOrder: true });
    expect(hi.parts.profitPotential).toBeGreaterThan(lo.parts.profitPotential!);
  });
});

let h: TestHarness;
afterEach(async () => h && (await h.close()));

describe('묶음 옵션 등록 → 주문', () => {
  it('옵션 3개 등록·옵션명으로 ID 매칭 → "2개" 옵션 주문은 공급처에 2개 발주, 배송비 1회', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({
      selection: { mode: 'manual_approve' },
      coupang: { vendorUserId: 'w', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588', returnZipCode: '1', returnAddress: '서울' },
    });
    h.apiSource.add({ sourceItemId: 'B1', title: '스텐 수납 정리함', price: 15000, shippingPerUnit: false, stock: 100 });
    await runSelection(h.ctx, { keywords: ['정리함'] });
    const c = await h.ctx.db.selectFrom('candidates').selectAll().where('passed', '=', true).executeTakeFirstOrThrow();
    const { listingId } = await decideCandidate(h.ctx, c.id, true, 'admin');
    const items = await h.ctx.db.selectFrom('listing_items').selectAll().where('listing_id', '=', listingId!).orderBy('unit_qty').execute();
    expect(items.map((i) => i.unit_qty)).toEqual([1, 2, 3]);
    expect(items.every((i) => i.sale_price % 1000 === 900)).toBe(true);
    expect(items[1]!.sale_price).toBeLessThan(items[0]!.sale_price * 2); // 묶음이 개당 저렴
    const l = await registerListing(h.ctx, listingId!);
    const payload = l.payload as any;
    expect(payload.items.map((i: any) => [i.unitCount, i.attributes[0].attributeValueName])).toEqual([[1, '1개'], [2, '2개'], [3, '3개']]);
    h.market.approve(l.seller_product_id!);
    await refreshListingStatuses(h.ctx);
    const mapped = await h.ctx.db.selectFrom('listing_items').selectAll().where('listing_id', '=', listingId!).orderBy('unit_qty').execute();
    expect(mapped.every((i) => !!i.vendor_item_id)).toBe(true);
    const two = mapped.find((i) => i.unit_qty === 2)!;
    const line = h.market.seedOrder({ vendorItemId: two.vendor_item_id!, qty: 1, paidAmount: two.sale_price, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    const o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('PURCHASED');
    const placed = [...h.apiSource.orders.values()][0]!;
    expect(placed.req.qty).toBe(2);
    expect(o.expected_cost).toBe(15000 * 2 + 3000); // 배송비 1회
    expect(o.expected_profit).toBeGreaterThan(0);
  });
});

describe('가격 자동 최적화', () => {
  it('잘 팔리면 인상 → 인상 후 안 팔리면 최고 가격으로 복귀 → 계속 안 팔리면 인하', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ pricing: { maxPriceChangesPerDay: 10 } });
    const { listing, vendorItemId } = await seedActiveListing(h, { salePrice: 25900, markup: 0.1 });
    await h.ctx.db.updateTable('listings').set({ floor_price: 23400, price_set_at: h.clock.now() }).where('id', '=', listing.id).execute();
    // 3일간 3건 판매
    for (let i = 0; i < 3; i++) h.market.seedOrder({ vendorItemId, paidAmount: 25900, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    h.clock.advanceMinutes(60 * 24 * 3);
    let r = await optimizePrices(h.ctx);
    expect(r.raised).toBe(1);
    let l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', listing.id).executeTakeFirstOrThrow();
    expect(l.markup).toBeCloseTo(0.14);
    expect(l.best_markup).toBeCloseTo(0.1);
    expect(l.sale_price).toBeGreaterThan(25900);
    expect(h.market.items.get(vendorItemId)!.price).toBe(l.sale_price);
    // 인상 후 5일 판매 없음 → 최고 기록(0.10)으로 복귀
    h.clock.advanceMinutes(60 * 24 * 5);
    r = await optimizePrices(h.ctx);
    expect(r.reverted).toBe(1);
    l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', listing.id).executeTakeFirstOrThrow();
    expect(l.markup).toBeCloseTo(0.1);
    // 그래도 5일 판매 없음 → 인하
    h.clock.advanceMinutes(60 * 24 * 5);
    r = await optimizePrices(h.ctx);
    expect(r.lowered).toBe(1);
    l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', listing.id).executeTakeFirstOrThrow();
    expect(l.markup).toBeCloseTo(0.06);
    expect(l.sale_price).toBeGreaterThanOrEqual(l.floor_price);
  });

  it('관찰 기간 전에는 바꾸지 않음, 쿠팡 경쟁 최저가를 넘겨 올리지 않음', async () => {
    h = await makeHarness({ live: true });
    const { listing, vendorItemId } = await seedActiveListing(h, { salePrice: 25900, markup: 0.1 });
    for (let i = 0; i < 3; i++) h.market.seedOrder({ vendorItemId, paidAmount: 25900, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    await h.ctx.db.updateTable('listings').set({ price_set_at: h.clock.now(), floor_price: 23400 }).where('id', '=', listing.id).execute();
    h.clock.advanceMinutes(60 * 24);
    expect((await optimizePrices(h.ctx)).checked).toBe(0);
    // 경쟁 최저가 26,000원 → 상한 마크업 = 26000×0.99/23400−1 ≈ 0.1
    const cand = await h.ctx.db.insertInto('candidates').values({ source_product_id: listing.source_product_id, keyword: 'k', score: 1, signals: '{}', gates: '[]', passed: true, market_lowest: 26000, run_id: 'r', status: 'listed', created_at: h.clock.now() }).returning('id').executeTakeFirstOrThrow();
    await h.ctx.db.updateTable('listings').set({ candidate_id: cand.id }).where('id', '=', listing.id).execute();
    h.clock.advanceMinutes(60 * 24 * 3);
    await optimizePrices(h.ctx);
    const l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', listing.id).executeTakeFirstOrThrow();
    expect(l.markup).toBeLessThanOrEqual(0.1001);
  });
});

describe('원가 절감·수수료 학습', () => {
  it('같은 상품명의 더 싼 상품으로 공급처 교체 + 가격 재계산', async () => {
    h = await makeHarness({ live: true });
    const { listing, src } = await seedActiveListing(h, { itemId: 'C1', price: 15000 });
    const title = src.products.get('C1')!.title;
    src.add({ sourceItemId: 'C2', title, price: 13000 }); // 같은 상품, 더 쌈
    src.add({ sourceItemId: 'C3', title: `${title} 다른것`, price: 9000 }); // 이름이 다르면 무시
    const r = await scoutCheaperSources(h.ctx);
    expect(r.switched).toBe(1);
    const l = await h.ctx.db.selectFrom('listings').innerJoin('source_products', 'source_products.id', 'listings.source_product_id').select(['source_products.source_item_id']).where('listings.id', '=', listing.id).executeTakeFirstOrThrow();
    expect(l.source_item_id).toBe('C2');
    expect(h.notifier.titles()).toContain('더 싼 공급처로 교체');
    expect((await scoutCheaperSources(h.ctx)).checked).toBe(0); // 주기 내 재탐색 안 함
  });

  it('정산 서비스이용료로 실제 수수료율 학습 → 이후 손익 계산에 사용', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId, listing, src } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    (src as any).ship([...src.orders.keys()][0]);
    h.clock.advanceMinutes(60 * 24 * 2);
    h.market.revenue.push({ marketOrderId: line.marketOrderId, vendorItemId, saleType: 'SALE', saleAmount: 30000, serviceFee: 3600, serviceFeeVat: 360, settlementAmount: 26040, deliverySettlement: 0, recognizedAt: '2026-10-14', raw: {} });
    await reconcile(h.ctx);
    const l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', listing.id).executeTakeFirstOrThrow();
    expect(l.fee_rate_actual).toBeCloseTo(0.12);
  });
});
