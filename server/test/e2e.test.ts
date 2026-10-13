import { afterEach, describe, expect, it } from 'vitest';
import { pollInquiries } from '../src/modules/cs/service.js';
import { monthlyCsv, reconcile } from '../src/modules/finance/service.js';
import { refreshListingStatuses, registerListing } from '../src/modules/listing/service.js';
import { importCoupangSalesCsv } from '../src/modules/marketdata/csvImport.js';
import {
  checkDelays, confirmPurchase, overrideAndProcess, pollClaims, pollFulfillment, pollNewOrders, processPending, purgePii, submitTracking,
} from '../src/modules/orders/service.js';
import { sendDailyReport, watchdog } from '../src/modules/reports/service.js';
import { decideCandidate, runSelection } from '../src/modules/selection/service.js';
import { reviewSlowListings, syncListings } from '../src/modules/sync/service.js';
import { makeHarness, orderByBox, seedActiveListing, type TestHarness } from './helpers.js';

let h: TestHarness;
afterEach(async () => h && (await h.close()));

/** 주문 1회 사이클(스케줄러가 하는 일) */
async function cycle(): Promise<void> {
  await pollNewOrders(h.ctx);
  await processPending(h.ctx);
  await pollClaims(h.ctx);
  await pollFulfillment(h.ctx);
}

describe('완전 자동 흐름 (API 발주 가능 공급처, LIVE)', () => {
  it('선정 → 자동등록 → 승인 → 주문 → 자동발주 → 송장 자동업로드 → 배송완료 → 정산 확정', async () => {
    h = await makeHarness({ live: true });
    h.apiSource.add({ sourceItemId: 'A1', title: '접이식 수납 정리함 대형', price: 15000, stock: 200 });
    h.apiSource.add({ sourceItemId: 'A2', title: '나이키 수납 정리함', price: 15000 }); // 상표 탈락
    h.marketData.lowest.set('수납 정리함', 35000);
    h.marketData.volume.set('수납 정리함', 25000);
    await h.ctx.settings.update({ selection: { seedKeywords: ['수납 정리함'] }, coupang: { vendorUserId: 'wing', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588-0000', returnZipCode: '04524', returnAddress: '서울' } });

    // 1) 선정 + 자동 등록
    const sel = await runSelection(h.ctx);
    expect(sel.evaluated).toBe(2);
    expect(sel.passed).toBe(1);
    expect(sel.autoListed).toBe(1);
    const listing = await h.ctx.db.selectFrom('listings').selectAll().executeTakeFirstOrThrow();
    expect(listing.status).toBe('pending_approval');
    expect(listing.title).toBe('접이식 수납 정리함 대형');
    const payload = listing.payload as any;
    expect(payload.items[0].salePrice).toBe(listing.sale_price);
    expect(payload.items[0].images[0].imageType).toBe('REPRESENTATION');
    expect(payload.items[0].notices.length).toBeGreaterThan(0);
    expect(payload.deliveryChargeType).toBe('FREE');

    // 2) 쿠팡 승인 → active + vendorItemId
    const vi = h.market.approve(listing.seller_product_id!);
    expect((await refreshListingStatuses(h.ctx)).approved).toBe(1);
    const active = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', listing.id).executeTakeFirstOrThrow();
    expect(active.status).toBe('active');
    expect(active.vendor_item_id).toBe(vi);

    // 3) 주문 발생 → 자동 발주
    const line = h.market.seedOrder({ vendorItemId: vi, paidAmount: active.sale_price, orderedAt: h.clock.now(), receiver: { name: '김고객', phone: '010-9999-8888', addr1: '부산 해운대구 A로 1', addr2: '2층', zip: '48000' } });
    await cycle();
    let o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('PURCHASED');
    expect(o.purchase_strategy).toBe('api');
    expect(o.acked_at).not.toBeNull();
    expect(o.expected_profit).toBeGreaterThanOrEqual(2000);
    expect(h.apiSource.orders.size).toBe(1);
    const [srcOrderId, srcOrder] = [...h.apiSource.orders.entries()][0]!;
    expect(srcOrder.req.receiver.name).toBe('김고객'); // 고객 배송지로 발주
    expect(srcOrder.req.idempotencyKey).toBe(`cp-${line.marketOrderId}-${vi}`);
    // 개인정보는 암호화 저장
    expect(o.receiver_name_enc).not.toContain('김고객');

    // 4) 같은 주문 재수집·재처리해도 중복 발주 없음
    await cycle();
    expect(h.apiSource.orders.size).toBe(1);
    expect(await h.ctx.db.selectFrom('orders').select('id').execute()).toHaveLength(1);

    // 5) 공급처 송장 등록 → 자동 회수·쿠팡 업로드
    h.apiSource.ship(srcOrderId, '612345678901', 'CJ대한통운');
    await cycle();
    o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('TRACKING_UPLOADED');
    expect(h.market.invoices[0]).toMatchObject({ courierCode: 'CJGLS', trackingNo: '612345678901' });

    // 6) 배송중 → 배송완료
    h.market.setStatus(line.shipmentBoxId, 'DELIVERING');
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('IN_TRANSIT');
    h.market.setStatus(line.shipmentBoxId, 'FINAL_DELIVERY');
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('DELIVERED');

    // 7) 정산 대사 → 확정 이익
    h.clock.advanceMinutes(60 * 24 * 8);
    h.market.revenue.push({ marketOrderId: line.marketOrderId, vendorItemId: vi, saleType: 'SALE', saleAmount: active.sale_price, serviceFee: 2000, serviceFeeVat: 200, settlementAmount: active.sale_price - 2200, deliverySettlement: 0, recognizedAt: '2026-10-20', raw: {} });
    const rec = await reconcile(h.ctx);
    expect(rec.settled).toBe(1);
    o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('SETTLED');
    expect(o.profit).toBe(active.sale_price - 2200 - 15000 - 3000);

    // 8) 월 손익 CSV
    const csv = await monthlyCsv(h.ctx, '2026-10');
    expect(csv).toContain(line.marketOrderId);
    expect(csv).toContain('합계');

    // 사람에게 '구매 필요' 알림은 한 번도 없어야 함(완전 자동)
    expect(h.notifier.titles()).not.toContain('구매할 주문이 있어요');
  });

  it('공급처가 결제를 요구하면 PAYMENT_PENDING → 결제완료 입력 후 진행', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h);
    h.apiSource.needsPayment = true;
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    let o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('PAYMENT_PENDING');
    expect(h.notifier.titles()).toContain('공급처 결제가 필요해요');
    o = await confirmPurchase(h.ctx, o.id, {}, 'admin');
    expect(o.status).toBe('PURCHASED');
    expect(o.source_order_id).toMatch(/^MO/);
  });

  it('공급처 일시 오류 → SOURCE_ERROR → 다음 주기에 자동 재시도 성공(중복 없음)', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h);
    h.apiSource.failNext.set('placeOrder', 1);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('SOURCE_ERROR');
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PURCHASED');
    expect(h.apiSource.orders.size).toBe(1);
  });

  it('쿠팡 API 일시 오류도 다음 주기에 회복', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    h.market.failNext.set('listOrders', 1);
    await expect(pollNewOrders(h.ctx)).rejects.toThrow();
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PURCHASED');
  });
});

describe('구매 대행 작업함 흐름 (API 없는 공급처)', () => {
  it('구매 필요 알림 → 원주문번호 입력 → 송장 입력 → 업로드', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h, { source: 'mockmanual' });
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    let o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('AWAITING_PURCHASE');
    expect(o.purchase_strategy).toBe('assisted');
    expect(o.acked_at).not.toBeNull(); // 상품준비중 처리로 고객 즉시취소 방지
    expect(h.notifier.titles()).toContain('구매할 주문이 있어요');
    await expect(confirmPurchase(h.ctx, o.id, {}, 'admin')).rejects.toThrow(/원주문번호/);
    o = await confirmPurchase(h.ctx, o.id, { sourceOrderId: 'NAVER-2026-1', cost: 15500, shippingCost: 3000 }, 'admin');
    expect(o.status).toBe('PURCHASED');
    expect(o.purchase_cost).toBe(15500);
    await expect(submitTracking(h.ctx, o.id, '없는택배', '1234567890', 'admin')).rejects.toThrow(/택배사/);
    o = await submitTracking(h.ctx, o.id, '롯데택배', '2345-6789-0123', 'admin');
    expect(o.status).toBe('TRACKING_UPLOADED');
    expect(h.market.invoices[0]).toMatchObject({ courierCode: 'HYUNDAI', trackingNo: '234567890123' });
  });

  it('잘못된 송장(재시도형 오류)은 저장 후 재시도, 올바른 송장으로 교정 가능', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h, { source: 'mockmanual' });
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    let o = await confirmPurchase(h.ctx, (await orderByBox(h, line.shipmentBoxId)).id, { sourceOrderId: 'X1' }, 'admin');
    o = await submitTracking(h.ctx, o.id, 'CJ대한통운', '12AB', 'admin');
    expect(o.status).toBe('PURCHASED');
    expect(o.tracking_no).toBe('12AB');
    o = await submitTracking(h.ctx, o.id, 'CJ대한통운', '612345678901', 'admin');
    expect(o.status).toBe('TRACKING_UPLOADED');
  });
});

describe('예외 처리', () => {
  it('공급처 품절 → OUT_OF_STOCK + 상품 자동 판매중지 + 알림', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId, listing, d } = await seedActiveListing(h);
    h.apiSource.products.get(d.sourceItemId)!.stock = 0;
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('OUT_OF_STOCK');
    expect((await h.ctx.db.selectFrom('listings').select('status').where('id', '=', listing.id).executeTakeFirstOrThrow()).status).toBe('paused');
    expect(h.market.items.get(vendorItemId)!.onSale).toBe(false);
    expect(h.notifier.titles()).toContain('품절 주문 발생');
    expect(h.apiSource.orders.size).toBe(0);
  });

  it('마진 역전 → MARGIN_NEGATIVE, 발주 안 함', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId, d } = await seedActiveListing(h);
    h.apiSource.products.get(d.sourceItemId)!.price = 40000;
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    const o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('MARGIN_NEGATIVE');
    expect(o.expected_profit).toBeLessThan(0);
    expect(h.apiSource.orders.size).toBe(0);
  });

  it('발주 한도 초과 → LIMIT_EXCEEDED → 관리자 강행 시 발주', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ orders: { perOrderMaxCost: 10000 } });
    const { vendorItemId } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    let o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('LIMIT_EXCEEDED');
    o = await overrideAndProcess(h.ctx, o.id, 'admin');
    expect(o.status).toBe('PURCHASED');
  });

  it('매핑 안 된 주문 → MANUAL_REVIEW', async () => {
    h = await makeHarness({ live: true });
    const line = h.market.seedOrder({ vendorItemId: 'UNKNOWN', orderedAt: h.clock.now() });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('MANUAL_REVIEW');
  });

  it('긴급 정지: 감지는 하되 발주·업로드 안 함, 해제 후 진행', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h);
    await h.ctx.settings.update({ killSwitch: true });
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('NEW');
    expect(h.apiSource.orders.size).toBe(0);
    await h.ctx.settings.update({ killSwitch: false });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PURCHASED');
  });

  it('구매 전 고객 취소 → CANCELLED, 구매 후 취소 → CANCEL_REQUESTED + 알림', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h, { source: 'mockmanual' });
    const a = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    const b = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    const ob = await orderByBox(h, b.shipmentBoxId);
    await confirmPurchase(h.ctx, ob.id, { sourceOrderId: 'S-B' }, 'admin');
    h.market.claims.push({ receiptId: 'r1', marketOrderId: a.marketOrderId, vendorItemId, type: 'CANCEL', status: 'RU', reason: '단순변심', requestedAt: h.clock.now() });
    h.market.claims.push({ receiptId: 'r2', marketOrderId: b.marketOrderId, vendorItemId, type: 'CANCEL', status: 'RU', reason: '단순변심', requestedAt: h.clock.now() });
    await pollClaims(h.ctx);
    expect((await orderByBox(h, a.shipmentBoxId)).status).toBe('CANCELLED');
    expect((await orderByBox(h, b.shipmentBoxId)).status).toBe('CANCEL_REQUESTED');
    expect(h.notifier.titles()).toContain('구매 후 취소 요청');
  });

  it('반품 요청 → RETURN_REQUESTED → 환불 정산 시 RETURNED', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId, src } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    const [sid] = [...src.orders.keys()];
    (src as any).ship(sid);
    await cycle();
    h.market.setStatus(line.shipmentBoxId, 'FINAL_DELIVERY');
    await cycle();
    h.market.claims.push({ receiptId: 'r9', marketOrderId: line.marketOrderId, vendorItemId, type: 'RETURN', status: 'UC', reason: '상품불량', requestedAt: h.clock.now() });
    await pollClaims(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('RETURN_REQUESTED');
    h.clock.advanceMinutes(60 * 48);
    h.market.revenue.push({ marketOrderId: line.marketOrderId, vendorItemId, saleType: 'REFUND', saleAmount: 30000, serviceFee: 0, serviceFeeVat: 0, settlementAmount: 30000, deliverySettlement: 0, recognizedAt: '2026-10-14', raw: {} });
    await reconcile(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('RETURNED');
  });

  it('지연 경고: 구매 작업 방치, 송장 지연 → SHIPPING_DELAYED', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h, { source: 'mockmanual' });
    const a = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    h.clock.advanceMinutes(60 * 4);
    expect((await checkDelays(h.ctx)).alerts).toBe(1);
    expect(h.notifier.titles()).toContain('미처리 구매 작업');
    const o = await confirmPurchase(h.ctx, (await orderByBox(h, a.shipmentBoxId)).id, { sourceOrderId: 'Z' }, 'admin');
    h.clock.advanceMinutes(60 * 40);
    await checkDelays(h.ctx);
    expect((await orderByBox(h, a.shipmentBoxId)).status).toBe('SHIPPING_DELAYED');
    // 지연 상태에서도 송장 입력 가능
    expect((await submitTracking(h.ctx, o.id, 'CJ대한통운', '612345678901', 'admin')).status).toBe('TRACKING_UPLOADED');
  });

  it('개인정보 파기: 배송완료 후 보관기간 경과', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId, src } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    (src as any).ship([...src.orders.keys()][0]);
    await cycle();
    h.market.setStatus(line.shipmentBoxId, 'FINAL_DELIVERY');
    await cycle();
    expect((await purgePii(h.ctx)).purged).toBe(0);
    h.clock.advanceMinutes(60 * 24 * 91);
    expect((await purgePii(h.ctx)).purged).toBe(1);
    const o = await orderByBox(h, line.shipmentBoxId);
    expect(o.receiver_name_enc).toBeNull();
    expect(o.receiver_addr_enc).toBeNull();
    expect(o.pii_purged_at).not.toBeNull();
  });
});

describe('DRY_RUN 기본 모드', () => {
  it('외부 부작용 없이 전체 흐름이 모의로 진행', async () => {
    h = await makeHarness({ live: false });
    const { vendorItemId } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    const o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('PURCHASED');
    expect(o.source_order_id).toMatch(/^DRY-/);
    expect(h.apiSource.orders.size).toBe(0); // 공급처 실제 발주 없음
    expect(h.market.calls).not.toContain('acknowledge'); // 쿠팡 상품준비중 실제 호출 없음
    const up = await submitTracking(h.ctx, o.id, 'CJ대한통운', '612345678901', 'admin');
    expect(up.status).toBe('TRACKING_UPLOADED');
    expect(h.market.invoices).toHaveLength(0);
  });

  it('DRY_RUN 등록은 가짜 ID로 즉시 승인 처리', async () => {
    h = await makeHarness({ live: false });
    h.apiSource.add({ sourceItemId: 'D1', title: '원목 수납 정리함', price: 15000 });
    h.marketData.lowest.set('정리함', 40000);
    const r = await runSelection(h.ctx, { keywords: ['정리함'] });
    expect(r.autoListed).toBe(1);
    await refreshListingStatuses(h.ctx);
    const l = await h.ctx.db.selectFrom('listings').selectAll().executeTakeFirstOrThrow();
    expect(l.status).toBe('active');
    expect(l.dry_run).toBe(true);
    expect(l.vendor_item_id).toMatch(/^DRYVI-/);
    expect(h.market.products.size).toBe(0);
  });
});

describe('선정 모드', () => {
  it('manual_approve: 자동 등록 없이 후보 알림 → 승인 시 초안', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ selection: { mode: 'manual_approve' } });
    h.apiSource.add({ sourceItemId: 'M1', title: '스텐 수납 정리함', price: 15000 });
    h.marketData.lowest.set('정리함', 40000);
    const r = await runSelection(h.ctx, { keywords: ['정리함'] });
    expect(r.autoListed).toBe(0);
    expect(h.notifier.titles().some((t) => t.startsWith('상품 후보'))).toBe(true);
    const c = await h.ctx.db.selectFrom('candidates').selectAll().where('passed', '=', true).executeTakeFirstOrThrow();
    const { listingId } = await decideCandidate(h.ctx, c.id, true, 'admin');
    const l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', listingId!).executeTakeFirstOrThrow();
    expect(l.status).toBe('draft');
  });

  it('API 발주 불가·이미지 재사용 불가 상품은 자동 등록하지 않음(사람 몫)', async () => {
    h = await makeHarness({ live: true });
    h.manualSource.add({ sourceItemId: 'N1', title: '패브릭 수납 정리함', price: 15000 });
    h.apiSource.add({ sourceItemId: 'N2', title: '플라스틱 수납 정리함', price: 15000, imageReuseAllowed: false, images: [] });
    h.marketData.lowest.set('정리함', 40000);
    const r = await runSelection(h.ctx, { keywords: ['정리함'] });
    expect(r.passed).toBe(2);
    expect(r.autoListed).toBe(0);
  });

  it('이미지 없는 초안은 등록 차단, 이미지 업로드 후 등록', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ selection: { mode: 'manual_approve' } });
    h.apiSource.add({ sourceItemId: 'P1', title: '철제 수납 정리함', price: 15000, imageReuseAllowed: false, images: [] });
    h.marketData.lowest.set('정리함', 40000);
    await runSelection(h.ctx, { keywords: ['정리함'] });
    const c = await h.ctx.db.selectFrom('candidates').selectAll().executeTakeFirstOrThrow();
    const { listingId } = await decideCandidate(h.ctx, c.id, true, 'admin');
    await expect(registerListing(h.ctx, listingId!)).rejects.toThrow(/이미지/);
    await expect(registerListing(h.ctx, listingId!)).rejects.toThrow(/쿠팡 정보 미입력/); // LIVE 등록은 판매자 정보 필수
    await h.ctx.settings.update({ coupang: { vendorUserId: 'wing', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588-0000', returnZipCode: '04524', returnAddress: '서울' } });
    const { updateDraft } = await import('../src/modules/listing/service.js');
    await updateDraft(h.ctx, listingId!, { images: ['http://localhost:8080/media/a.jpg'] }, 'admin');
    const l = await registerListing(h.ctx, listingId!);
    expect(l.status).toBe('pending_approval');
  });

  it('쿠팡 판매량 CSV 임포트 → 신호에 반영', async () => {
    h = await makeHarness({ live: true });
    const r = await importCoupangSalesCsv(h.ctx, '키워드,월판매량\n정리함,"1,200"\n빈값,\n', 'itemscout');
    expect(r).toEqual({ imported: 1, skipped: 1 });
    await expect(importCoupangSalesCsv(h.ctx, 'a,b\n1,2', 'x')).rejects.toThrow(/열을 찾을 수 없습니다/);
  });
});

describe('동기화·판매 관리', () => {
  it('공급가 상승 → 판매가 자동 인상(가드 범위), 품절 → 중지, 재입고 → 재개', async () => {
    h = await makeHarness({ live: true });
    const { listing, d, vendorItemId } = await seedActiveListing(h, { price: 15000, salePrice: 24000 });
    h.apiSource.products.get(d.sourceItemId)!.price = 17000;
    let r = await syncListings(h.ctx);
    expect(r.repriced).toBe(1);
    let l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', listing.id).executeTakeFirstOrThrow();
    expect(l.sale_price).toBeGreaterThan(24000);
    expect(l.sale_price).toBe(l.floor_price);
    expect(h.market.items.get(vendorItemId)!.price).toBe(l.sale_price);

    h.apiSource.products.get(d.sourceItemId)!.status = 'soldout';
    r = await syncListings(h.ctx);
    expect(r.paused).toBe(1);
    l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', listing.id).executeTakeFirstOrThrow();
    expect(l.status).toBe('paused');

    h.apiSource.products.get(d.sourceItemId)!.status = 'active';
    r = await syncListings(h.ctx);
    expect(r.resumed).toBe(1);
    expect(h.market.items.get(vendorItemId)!.onSale).toBe(true);
  });

  it('하루 가격 변경 횟수 제한', async () => {
    h = await makeHarness({ live: true });
    const { d, listing } = await seedActiveListing(h, { price: 15000, salePrice: 24000 });
    for (const p of [16000, 17000, 18000]) {
      h.apiSource.products.get(d.sourceItemId)!.price = p;
      await syncListings(h.ctx);
    }
    const changes = await h.ctx.db.selectFrom('price_changes').selectAll().where('listing_id', '=', listing.id).execute();
    expect(changes).toHaveLength(2);
  });

  it('판매 부진: 하한가 1회 인하 → 이후에도 0건이면 판매종료', async () => {
    h = await makeHarness({ live: true });
    const { listing } = await seedActiveListing(h, { salePrice: 30000 });
    h.clock.advanceMinutes(60 * 24 * 15);
    expect((await reviewSlowListings(h.ctx)).lowered).toBe(1);
    expect((await h.ctx.db.selectFrom('listings').select('sale_price').where('id', '=', listing.id).executeTakeFirstOrThrow()).sale_price).toBe(24000); // -20% 가드
    h.clock.advanceMinutes(60 * 24 * 15);
    expect((await reviewSlowListings(h.ctx)).stopped).toBe(1);
    expect((await h.ctx.db.selectFrom('listings').select('status').where('id', '=', listing.id).executeTakeFirstOrThrow()).status).toBe('stopped');
  });
});

describe('CS·리포트·감시', () => {
  it('배송 문의 자동답변, 불만 문의는 초안 + 알림', async () => {
    h = await makeHarness({ live: true });
    h.market.inquiries.push({ inquiryId: 'q1', kind: 'product', content: '언제 배송되나요?', askedAt: h.clock.now(), answered: false });
    h.market.inquiries.push({ inquiryId: 'q2', kind: 'product', content: '파손되어 왔어요 환불해주세요', askedAt: h.clock.now(), answered: false });
    const r = await pollInquiries(h.ctx);
    expect(r).toEqual({ fetched: 2, autoAnswered: 1, drafted: 1 });
    expect(h.market.replies.map((x) => x.inquiryId)).toEqual(['q1']);
    expect(h.notifier.titles()).toContain('고객문의 1건 답변 필요');
    expect((await pollInquiries(h.ctx)).fetched).toBe(0); // 중복 수집 없음
  });

  it('일일 리포트 · 감시(폴링 정지, 키 만료)', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ coupang: { keyIssuedAt: '2026-04-30' } });
    const body = await sendDailyReport(h.ctx);
    expect(body).toContain('어제');
    expect(body).toContain('키 만료까지 14일');
    h.clock.advanceMinutes(60);
    const w = await watchdog(h.ctx);
    expect(w.alerts).toBe(2);
    expect(h.notifier.titles()).toContain('주문 수집이 멈췄습니다');
    await pollNewOrders(h.ctx);
    h.notifier.sent = [];
    await watchdog(h.ctx);
    expect(h.notifier.titles()).not.toContain('주문 수집이 멈췄습니다');
  });

  it('공인 IP 감시: 최초 안내 → 변경 시 경고(중복 없이)', async () => {
    let ip = '1.2.3.4';
    h = await makeHarness({ live: true, publicIp: async () => ip });
    const { checkPublicIp } = await import('../src/modules/reports/service.js');
    expect(await checkPublicIp(h.ctx)).toBe(0);
    expect(h.notifier.titles()).toContain('서버 공인 IP: 1.2.3.4');
    expect(await checkPublicIp(h.ctx)).toBe(0);
    ip = '5.6.7.8';
    expect(await checkPublicIp(h.ctx)).toBe(1);
    expect(h.notifier.titles()).toContain('공인 IP 변경: 1.2.3.4 → 5.6.7.8');
    expect(await checkPublicIp(h.ctx)).toBe(0);
  });

  it('첫 상품 수동 등록 지원: 견적 → 쿠팡 기존 상품 연결 → 주문 자동 발주', async () => {
    h = await makeHarness({ live: true });
    const { quoteSourceItem, linkExistingListing } = await import('../src/modules/listing/service.js');
    h.apiSource.add({ sourceItemId: 'Q1', title: '[무료배송] 스텐 수납 정리함 특가', price: 15000 });
    const q = await quoteSourceItem(h.ctx, 'mockapi', 'Q1');
    expect(q.suggestedTitle).toBe('스텐 수납 정리함');
    expect(q.salePrice).toBeGreaterThan(15000);
    expect(q.profit!.profit).toBeGreaterThanOrEqual(2000);
    expect(q.images.length).toBe(1);
    expect(q.apiOrder).toBe(true);
    await expect(quoteSourceItem(h.ctx, 'nope', 'Q1')).rejects.toThrow(/등록되지 않은 공급처/);

    // 판매가가 기준보다 낮으면 경고
    const low = await linkExistingListing(h.ctx, { vendorItemId: '70001', salePrice: 10000, source: 'mockapi', sourceItemId: 'Q1' }, 'admin');
    expect(low.warning).toMatch(/낮습니다/);
    await expect(linkExistingListing(h.ctx, { vendorItemId: '70001', salePrice: q.salePrice!, source: 'mockapi', sourceItemId: 'Q1' }, 'admin')).rejects.toThrow(/이미 연결/);
    await h.ctx.db.updateTable('listings').set({ status: 'stopped' }).where('id', '=', low.listing.id).execute();

    const { listing, warning } = await linkExistingListing(h.ctx, { vendorItemId: '70002', sellerProductId: '9001', salePrice: q.salePrice!, source: 'mockapi', sourceItemId: 'Q1' }, 'admin');
    expect(warning).toBeNull();
    expect(listing.status).toBe('active');
    const line = h.market.seedOrder({ vendorItemId: '70002', paidAmount: q.salePrice!, orderedAt: h.clock.now() });
    await cycle();
    const o = await orderByBox(h, line.shipmentBoxId);
    expect(o.listing_id).toBe(listing.id);
    expect(o.status).toBe('PURCHASED');
  });

  it('데이터랩 없이: 연관 키워드 자동 확장 + 구글/쿠팡 신호 저장 + 쿠팡 최저가 게이트', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ selection: { mode: 'manual_approve', expandRelatedPerSeed: 2 } });
    h.marketData.related.set('정리함', [
      { keyword: '서랍 정리함', volume: 8000, competition: '낮음' },
      { keyword: '옷 정리함', volume: 300000, competition: '중간' }, // 검색량 상한 초과
      { keyword: '공구 정리함', volume: 5000, competition: '높음' }, // 경쟁 높음 제외
      { keyword: '책상 정리함', volume: 3000, competition: '중간' },
    ]);
    h.apiSource.add({ sourceItemId: 'R1', title: '서랍 정리함 3단', price: 15000 });
    h.apiSource.add({ sourceItemId: 'R2', title: '책상 정리함 원목', price: 15000 });
    h.marketData.lowest.set('서랍 정리함', 40000);
    h.marketData.lowest.set('책상 정리함', 40000);
    h.marketData.coupang.set('책상 정리함', { lowest: 15000, median: 20000, rocketRatio: 0.8, count: 10 }); // 쿠팡엔 더 싼 경쟁자
    h.marketData.google.set('서랍 정리함', [10, 10, 10, 10, 30, 30, 30, 30]);
    const r = await runSelection(h.ctx, { keywords: ['정리함'] });
    expect(r.keywords).toBe(3); // 정리함 + 서랍 정리함 + 책상 정리함
    const cands = await h.ctx.db.selectFrom('candidates').innerJoin('source_products', 'source_products.id', 'candidates.source_product_id').select(['source_products.source_item_id as id', 'candidates.passed', 'candidates.keyword']).execute();
    const r1 = cands.find((c) => c.id === 'R1' && c.keyword === '서랍 정리함')!;
    const r2 = cands.find((c) => c.id === 'R2' && c.keyword === '책상 정리함')!;
    expect(r1.passed).toBe(true);
    expect(r2.passed).toBe(false); // 쿠팡 최저가보다 비쌈
    const kinds = (await h.ctx.db.selectFrom('market_signals').select('kind').distinct().execute()).map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(['related_of', 'google_trend', 'coupang_lowest', 'coupang_rocket_ratio']));
  });

  it('CSV: 판매량 외 리뷰수·상품수·평균가 열도 저장', async () => {
    h = await makeHarness({ live: true });
    const r = await importCoupangSalesCsv(h.ctx, '키워드,쿠팡 판매량,리뷰수,평균가\n정리함,500,"1,234",19900\n', 'pandarank');
    expect(r.imported).toBe(1);
    const rows = await h.ctx.db.selectFrom('market_signals').select(['kind', 'value']).where('keyword', '=', '정리함').execute();
    expect(rows).toEqual(expect.arrayContaining([{ kind: 'coupang_sales_est', value: 500 }, { kind: 'coupang_reviews', value: 1234 }, { kind: 'coupang_avg_price', value: 19900 }]));
  });
});
