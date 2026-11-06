import { afterEach, describe, expect, it } from 'vitest';
import { getHalt, haltSales, HALT_REASON, resumeSales, safetyCheck, safetyStatus } from '../src/modules/guard/safety.js';
import { refreshListingStatuses } from '../src/modules/listing/service.js';
import { pollClaims, pollFulfillment, pollNewOrders, processPending, transition } from '../src/modules/orders/service.js';
import { runSelection } from '../src/modules/selection/service.js';
import { syncListings } from '../src/modules/sync/service.js';
import { makeHarness, orderByBox, seedActiveListing, type TestHarness, logged } from './helpers.js';

/** 구매자 보호 안전장치: 문제 감지 → 경고 → 유예 후 자동 판매 중지, 결제된 주문은 계속 처리 */
let h: TestHarness;
afterEach(async () => h && (await h.close()));

async function cycle() {
  await pollNewOrders(h.ctx);
  await processPending(h.ctx);
  await pollClaims(h.ctx);
  await pollFulfillment(h.ctx);
}
/** 시간 경과(그동안 스케줄러가 주문 수집을 계속했다고 가정) */
const hours = async (n: number) => {
  h.clock.advanceMinutes(n * 60);
  await pollNewOrders(h.ctx);
};
const listingStatus = async (id: number) => (await h.ctx.db.selectFrom('listings').select(['status', 'status_reason']).where('id', '=', id).executeTakeFirstOrThrow());

describe('자동 판매 중지', () => {
  it('품절 주문을 6시간 방치 → 경고 → 3시간 더 방치 → 쿠팡 판매 전부 중지 → 해결 후 재개', async () => {
    h = await makeHarness({ live: true });
    const a = await seedActiveListing(h, { stock: 0 }); // 품절 상품에 주문
    const b = await seedActiveListing(h); // 정상 상품
    const line = h.market.seedOrder({ vendorItemId: a.vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('OUT_OF_STOCK');

    expect((await safetyCheck(h.ctx)).issues).toBe(0); // 아직 6시간 전
    await hours(6.5);
    let r = await safetyCheck(h.ctx);
    expect(r).toMatchObject({ newIssues: 1, halted: false });
    const warn = h.notifier.sent.find((m) => m.title === '⚠️ 문제 감지')!;
    expect(warn.body).toContain('3시간 안에 해결되지 않으면 자동으로 판매를 중지');
    expect(warn.body).toContain('해결 방법');

    await hours(3.1);
    r = await safetyCheck(h.ctx);
    expect(r.halted).toBe(true);
    expect(h.notifier.titles()).toContain('🛑 자동 판매 중지');
    expect(h.market.items.get(b.vendorItemId)!.onSale).toBe(false); // 정상 상품도 판매중지(새 주문 차단)
    expect(await listingStatus(b.listing.id)).toMatchObject({ status: 'paused', status_reason: HALT_REASON });

    // 판매 중지 중: 자동 재개·자동 등록 금지
    await syncListings(h.ctx);
    expect((await listingStatus(b.listing.id)).status).toBe('paused');
    h.apiSource.add({ sourceItemId: 'N1', title: '접이식 수납 정리함 대형', price: 15000, stock: 100 });
    h.marketData.volume.set('수납 정리함', 25000);
    await h.ctx.settings.update({ selection: { seedKeywords: ['수납 정리함'] }, coupang: { vendorUserId: 'wing', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588-0000', returnZipCode: '04524', returnAddress: '서울' } });
    expect((await runSelection(h.ctx)).autoListed).toBe(0);

    // 사람이 해결(Wing에서 고객 취소 → 상태 변경) → 문제 해결 알림 → 판매 재개
    const o = await orderByBox(h, line.shipmentBoxId);
    await transition(h.ctx, o, 'CANCELLED', '품절 취소', 'admin');
    r = await safetyCheck(h.ctx);
    expect(r.resolved).toBe(1);
    expect(r.issues).toBe(0);
    expect((await resumeSales(h.ctx, 'admin')).resumed).toBeGreaterThanOrEqual(1);
    expect(h.market.items.get(b.vendorItemId)!.onSale).toBe(true);
    expect(await getHalt(h.ctx)).toBeNull();
  });

  it('판매 중지 중에도 이미 결제된 주문은 끝까지 처리(구매자 보호)', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await haltSales(h.ctx, '테스트', 'auto');
    await cycle();
    const o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('PURCHASED');
    h.apiSource.ship(o.source_order_id!);
    await pollFulfillment(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('TRACKING_UPLOADED');
  });

  it('짧은 시간에 예외 주문 3건 → 기다리지 않고 즉시 판매 중지(구조적 오류)', async () => {
    h = await makeHarness({ live: true });
    for (let i = 0; i < 3; i++) {
      const { vendorItemId } = await seedActiveListing(h, { stock: 0 });
      h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    }
    await cycle();
    const r = await safetyCheck(h.ctx);
    expect(r.halted).toBe(true);
    expect((await getHalt(h.ctx))!.reason).toContain('예외 주문 3건');
  });

  it('출고 기한 지남·주문 수집 중단도 감지, 해결 안 되면 재알림', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now(), shipBy: '2026-10-12' });
    await cycle(); // PURCHASED, 송장 없음, 기한(어제) 지남
    await h.ctx.kv.set('orders.lastPollOkAt', new Date(h.clock.now().getTime() - 2 * 3600_000).toISOString());
    await h.ctx.kv.set('app.startedAt', new Date(h.clock.now().getTime() - 3 * 3600_000).toISOString()); // 재시작 직후 아님
    const st = await safetyCheck(h.ctx);
    expect(st.newIssues).toBe(2);
    const keys = (await safetyStatus(h.ctx)).issues.map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining([`late-${(await orderByBox(h, line.shipmentBoxId)).id}`, 'poll-down']));
    const before = h.notifier.sent.length;
    h.clock.advanceMinutes(60);
    await safetyCheck(h.ctx);
    expect(h.notifier.sent.length).toBe(before); // 1시간 뒤엔 재알림 없음
    h.clock.advanceMinutes(126);
    await safetyCheck(h.ctx); // 3시간 경과 → 판매 중지 + 재알림
    expect(h.notifier.titles()).toContain('⏰ 아직 해결 안 된 문제');
  });

  it('판매 중지 중 쿠팡 승인된 새 상품은 바로 멈춤, 자동 판매 중지 끄면(autoHalt=false) 경고만', async () => {
    h = await makeHarness({ live: true });
    await haltSales(h.ctx, '테스트', 'auto');
    const { listing } = await seedActiveListing(h);
    await h.ctx.db.updateTable('listings').set({ status: 'pending_approval', vendor_item_id: null, dry_run: false }).where('id', '=', listing.id).execute();
    h.market.products.set(listing.seller_product_id!, { payload: {}, status: 'APPROVED', vendorItemIds: ['VNEW'] });
    h.market.items.set('VNEW', { price: 30000, qty: 10, onSale: true });
    await refreshListingStatuses(h.ctx);
    expect(await listingStatus(listing.id)).toMatchObject({ status: 'paused', status_reason: HALT_REASON });
    expect(h.market.items.get('VNEW')!.onSale).toBe(false);
    await h.close();

    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ safety: { autoHalt: false } });
    for (let i = 0; i < 3; i++) {
      const { vendorItemId } = await seedActiveListing(h, { stock: 0 });
      h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    }
    await cycle();
    expect((await safetyCheck(h.ctx)).halted).toBe(false);
    expect(h.notifier.titles()).toContain('⚠️ 문제 감지');
  });
});

describe('주문별 구매자 보호', () => {
  it('소액 손실(2,000원 이내)은 그대로 발송 + 상품만 중지, 큰 손실은 보류', async () => {
    h = await makeHarness({ live: true });
    const small = await seedActiveListing(h, { price: 15000 });
    // 판매가를 이익이 살짝 마이너스가 되도록
    let l1 = h.market.seedOrder({ vendorItemId: small.vendorItemId, paidAmount: 19800, orderedAt: h.clock.now() });
    await cycle();
    let o = await orderByBox(h, l1.shipmentBoxId);
    if (o.expected_profit! >= 0) {
      // 수수료 계산에 따라 이익이 남으면 판매가를 더 낮춰 다시
      l1 = h.market.seedOrder({ vendorItemId: small.vendorItemId, paidAmount: 19000, orderedAt: h.clock.now() });
      await cycle();
      o = await orderByBox(h, l1.shipmentBoxId);
    }
    expect(o.expected_profit!).toBeLessThan(0);
    expect(o.expected_profit!).toBeGreaterThanOrEqual(-2000);
    expect(o.status).toBe('PURCHASED');
    expect((await logged(h.ctx)).map((x) => x.title)).toContain('소액 손실 주문 — 그대로 발송'); // 자동 처리됨 → 대시보드에만
    expect((await listingStatus(small.listing.id)).status).toBe('paused');

    const big = await seedActiveListing(h, { price: 40000 });
    const l2 = h.market.seedOrder({ vendorItemId: big.vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    expect((await orderByBox(h, l2.shipmentBoxId)).status).toBe('MARGIN_NEGATIVE');
  });
});

describe('구매자 응대 누락 방지', () => {
  it('교환 요청은 1회 알림, 고객센터 이관 문의는 자동답변 없이 바로 알림, Wing에서 답변하면 재알림 중단', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    h.market.claims.push({ receiptId: 'x1', marketOrderId: line.marketOrderId, vendorItemId, type: 'EXCHANGE', status: 'RECEIPT', reason: '사이즈', requestedAt: h.clock.now() });
    await pollClaims(h.ctx);
    await pollClaims(h.ctx);
    expect(h.notifier.titles().filter((t) => t === '교환 요청')).toHaveLength(1);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PURCHASED'); // 주문 상태는 그대로

    const { pollInquiries } = await import('../src/modules/cs/service.js');
    h.market.inquiries.push({ inquiryId: 'cc1', kind: 'callcenter', content: '배송 언제 되나요', askedAt: h.clock.now(), answered: false });
    const r = await pollInquiries(h.ctx);
    expect(r.autoAnswered).toBe(0); // '배송' 템플릿이 있어도 고객센터 이관 건은 사람이
    expect(h.market.replies).toHaveLength(0);
    expect(h.notifier.titles()).toContain('쿠팡 고객센터 문의(급함)');

    h.clock.advanceMinutes(13 * 60);
    await pollNewOrders(h.ctx);
    let st = await safetyCheck(h.ctx);
    expect((await safetyStatus(h.ctx)).issues.map((i) => i.key)).toContain('inquiries');
    expect(st.halted).toBe(false); // 문의는 판매 중지 사유 아님
    h.market.inquiries[0]!.answered = true; // Wing에서 답변
    await pollInquiries(h.ctx);
    st = await safetyCheck(h.ctx);
    expect((await safetyStatus(h.ctx)).issues.map((i) => i.key)).not.toContain('inquiries');
  });

  it('한 묶음배송에 상품 2개(공급처 따로 출고) → 분리배송으로 송장 등록', async () => {
    h = await makeHarness({ live: true });
    const a = await seedActiveListing(h);
    const b = await seedActiveListing(h);
    const l1 = h.market.seedOrder({ vendorItemId: a.vendorItemId, paidAmount: 30000, orderedAt: h.clock.now(), shipmentBoxId: 'BOX1', marketOrderId: 'ORD1' });
    h.market.seedOrder({ vendorItemId: b.vendorItemId, paidAmount: 30000, orderedAt: h.clock.now(), shipmentBoxId: 'BOX1', marketOrderId: 'ORD1' });
    await cycle();
    const orders = await h.ctx.db.selectFrom('orders').selectAll().where('shipment_box_id', '=', l1.shipmentBoxId).orderBy('id').execute();
    expect(orders.map((o) => o.status)).toEqual(['PURCHASED', 'PURCHASED']);
    h.apiSource.ship(orders[0]!.source_order_id!, '111111111111');
    await pollFulfillment(h.ctx);
    h.apiSource.ship(orders[1]!.source_order_id!, '222222222222');
    await pollFulfillment(h.ctx);
    expect(h.market.invoices.map((i) => [i.splitShipping, i.preSplitShipped])).toEqual([[true, false], [true, true]]);
  });
});

describe('알림 통로 고장 대비', () => {
  it('텔레그램 전송이 계속 실패하면 외부 감시(healthchecks)에 실패 신호 → 이메일로 알게 됨', async () => {
    const { vi } = await import('vitest');
    const { watchdog } = await import('../src/modules/reports/service.js');
    h = await makeHarness({ live: true, env: { HEARTBEAT_URL: 'https://hc.example/abc' } });
    const urls: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (u: string) => (urls.push(String(u)), new Response('ok'))) as any);
    try {
      await watchdog(h.ctx);
      expect(urls).toEqual(['https://hc.example/abc']); // 정상: 생존 신호
      h.notifier.send = async () => false; // 텔레그램 고장
      await h.ctx.notifications.notify('error', 'a', 'b');
      await h.ctx.notifications.notify('error', 'c', 'd');
      urls.length = 0;
      await watchdog(h.ctx);
      expect(urls).toEqual(['https://hc.example/abc/fail']);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('텔레그램 알림 선별(바로 확인할 것만)', () => {
  it('info·상품 운영 알림은 대시보드에만, 주문·CS·서버 문제는 텔레그램까지', async () => {
    h = await makeHarness();
    await h.ctx.notifications.notify('info', '상품 판매 시작', 'x');
    await h.ctx.notifications.notify('warn', '상품 승인 반려', 'x', { push: false });
    await h.ctx.notifications.notify('action', '구매할 주문이 있어요', 'x');
    await h.ctx.notifications.notify('error', '주문 수집이 멈췄습니다', 'x');
    await h.ctx.notifications.notify('info', '✅ 문제 해결됨', 'x', { push: true });
    expect(h.notifier.titles()).toEqual(['구매할 주문이 있어요', '주문 수집이 멈췄습니다', '✅ 문제 해결됨']);
    const rows = await logged(h.ctx);
    expect(rows.map((r) => [r.title, r.pushed])).toEqual([
      ['상품 판매 시작', false], ['상품 승인 반려', false], ['구매할 주문이 있어요', true], ['주문 수집이 멈췄습니다', true], ['✅ 문제 해결됨', true],
    ]);
  });

  it('텔레그램 대상이 아닌 알림이 많아도 알림 통로 고장으로 오인하지 않음', async () => {
    const { vi } = await import('vitest');
    const { watchdog } = await import('../src/modules/reports/service.js');
    h = await makeHarness({ live: true, env: { HEARTBEAT_URL: 'https://hc.example/abc' } });
    const urls: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (u: string) => (urls.push(String(u)), new Response('ok'))) as any);
    try {
      for (let i = 0; i < 5; i++) await h.ctx.notifications.notify('info', `상품 판매 시작 ${i}`, 'x');
      await watchdog(h.ctx);
      expect(urls).toEqual(['https://hc.example/abc']);
    } finally {
      spy.mockRestore();
    }
  });

  it('핵심 작업(주문·송장·재고·CS·감시) 실패만 텔레그램', async () => {
    const { JOBS } = await import('../src/jobs/scheduler.js');
    expect(JOBS.filter((j) => j.critical).map((j) => j.name).sort()).toEqual(['cs.poll', 'listings.sync', 'notify.digest', 'orders.fulfillment', 'orders.poll', 'watchdog']);
  });

  it('아침 브리핑: 처리할 일이 없으면 대시보드에만, 있으면 텔레그램', async () => {
    const { sendDailyReport } = await import('../src/modules/reports/service.js');
    h = await makeHarness();
    await h.ctx.kv.set('orders.lastPollOkAt', h.clock.now().toISOString());
    await sendDailyReport(h.ctx);
    expect(h.notifier.titles().some((t) => t.startsWith('☀️ 아침 브리핑'))).toBe(false);
    expect((await logged(h.ctx)).some((t) => t.title.startsWith('☀️ 아침 브리핑'))).toBe(true);
    await h.ctx.kv.set('orders.lastPollOkAt', null); // 주문 수집 이상
    await sendDailyReport(h.ctx);
    expect(h.notifier.titles().some((t) => t.startsWith('☀️ 아침 브리핑'))).toBe(true);
  });
});
