import { afterEach, describe, expect, it } from 'vitest';
import { parseExchange, parseReturnReceipt } from '../src/adapters/coupang/market.js';
import { claimAction, reshipOrder, sellerCancel } from '../src/modules/orders/claims.js';
import { reconcile } from '../src/modules/finance/service.js';
import { confirmPurchase, pollClaims, pollFulfillment, pollNewOrders, processPending } from '../src/modules/orders/service.js';
import { makeHarness, orderByBox, seedActiveListing, type TestHarness } from './helpers.js';

/** 취소·반품·교환(클레임)을 쿠팡 접수 단위로 끝까지 처리 */
let h: TestHarness;
afterEach(async () => h && (await h.close()));

async function cycle() {
  await pollNewOrders(h.ctx);
  await processPending(h.ctx);
  await pollClaims(h.ctx);
  await pollFulfillment(h.ctx);
}

/** 오너클랜(자동 발주) 상품 주문 → 상품준비중 + 공급처 주문까지 */
async function purchased(opts: { source?: 'mockapi' | 'mockmanual' } = {}) {
  h = await makeHarness({ live: true });
  const { vendorItemId, src } = await seedActiveListing(h, opts);
  const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
  await cycle();
  let o = await orderByBox(h, line.shipmentBoxId);
  if (opts.source === 'mockmanual') o = await confirmPurchase(h.ctx, o.id, { sourceOrderId: 'DMK-1', cost: 15000 }, 'admin');
  return { vendorItemId, src, line, o };
}
const claim = (c: Parameters<TestHarness['market']['claim']>[0]) => h.market.claim({ requestedAt: h.clock.now(), ...c });
const claimsOf = (orderId: number) => h.ctx.db.selectFrom('order_claims').selectAll().where('order_id', '=', orderId).execute();

describe('쿠팡 응답 해석', () => {
  it('상품준비중 고객 취소(RU·미출고) = 출고중지요청, 출고 후 = 반품, 출고중지 완료 = 취소완료, 즉시취소 = 취소완료', () => {
    const base = { receiptId: 9, orderId: 1, cancelReasonCategory1: '단순변심', cancelCountSum: 1, createdAt: '2026-10-14T10:00:00' };
    const it = (releaseStatus: string) => [{ vendorItemId: 77, cancelCount: 1, releaseStatus, shipmentBoxId: 5 }];
    expect(parseReturnReceipt({ ...base, receiptType: 'RETURN', receiptStatus: 'RELEASE_STOP_UNCHECKED', returnItems: it('N') })[0]).toMatchObject({ stage: 'stop_requested', vendorItemId: '77', count: 1, shipmentBoxId: '5' });
    expect(parseReturnReceipt({ ...base, receiptType: 'RETURN', receiptStatus: 'RETURNS_UNCHECKED', returnItems: it('N') })[0]!.stage).toBe('stop_requested');
    expect(parseReturnReceipt({ ...base, receiptType: 'RETURN', receiptStatus: 'RETURNS_UNCHECKED', returnItems: it('Y'), returnShippingCharge: { units: -3000, nanos: 0 }, faultByType: 'CUSTOMER' })[0]).toMatchObject({ stage: 'return_requested', returnShippingCharge: -3000, faultBy: 'CUSTOMER' });
    expect(parseReturnReceipt({ ...base, receiptType: 'RETURN', receiptStatus: 'VENDOR_WAREHOUSE_CONFIRM', returnItems: it('Y') })[0]!.stage).toBe('return_collected');
    expect(parseReturnReceipt({ ...base, receiptType: 'RETURN', receiptStatus: 'RETURNS_COMPLETED', returnItems: it('S'), releaseStopStatus: '처리(출고중지)' })[0]!.stage).toBe('cancelled');
    expect(parseReturnReceipt({ ...base, receiptType: 'RETURN', receiptStatus: 'RETURNS_COMPLETED', returnItems: it('Y') })[0]!.stage).toBe('return_done');
    expect(parseReturnReceipt({ ...base, receiptType: 'CANCEL', receiptStatus: 'RETURNS_COMPLETED', returnItems: it('N') })[0]!.stage).toBe('cancelled');
    expect(parseExchange({ exchangeId: 3, orderId: 1, exchangeStatus: 'PROGRESS', exchangeItemDtoV1s: [{ orderItemId: 77, quantity: 1 }] })[0]).toMatchObject({ type: 'EXCHANGE', stage: 'exchange_open', vendorItemId: '77' });
    expect(parseExchange({ exchangeId: 3, orderId: 1, exchangeStatus: 'CANCEL' })[0]!.stage).toBe('withdrawn');
  });
});

describe('고객 취소(상품준비중 = 출고중지요청)', () => {
  it('공급처가 바로 취소(결제완료) → 출고중지완료 → 취소됨, 다시 돌려도 중복 처리 없음', async () => {
    const { vendorItemId, line, o } = await purchased();
    expect(o.status).toBe('PURCHASED');
    claim({ receiptId: '501', marketOrderId: line.marketOrderId, vendorItemId, type: 'RETURN', stage: 'stop_requested' });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCELLED');
    expect(h.apiSource.cancelled).toEqual([o.source_order_id]);
    expect(h.market.claimActions.map((a) => a.action)).toEqual(['stopShipment']);
    const [c] = await claimsOf(o.id);
    expect(c).toMatchObject({ stage: 'stop_requested', action: 'stop_shipment' });
    expect(c!.closed_at).not.toBeNull();
    await cycle();
    await cycle();
    expect(h.market.claimActions).toHaveLength(1);
    expect(h.apiSource.cancelled).toHaveLength(1);
    expect(h.market.invoices).toHaveLength(0); // 취소된 주문엔 송장 안 올림
  });

  it('공급처가 준비중(취소 요청 → 수락 대기) → 수락되면 출고중지완료, 오래 걸리면 1회 알림', async () => {
    const { vendorItemId, line, o, src } = await purchased();
    (src as any).cancelMode = 'request';
    claim({ receiptId: '502', marketOrderId: line.marketOrderId, vendorItemId, type: 'RETURN', stage: 'stop_requested' });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCEL_REQUESTED');
    expect(h.notifier.titles()).toContain('고객 취소 — 공급처 취소 요청함');
    expect(h.market.claimActions).toHaveLength(0);
    h.clock.advanceMinutes(60 * 25);
    await cycle();
    await cycle();
    expect(h.notifier.titles().filter((t) => t === '공급처 취소 수락 지연')).toHaveLength(1);
    // 공급사 수락
    (src as any).orderStates.set(o.source_order_id, 'cancelled');
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCELLED');
    expect(h.market.claimActions.map((a) => a.action)).toEqual(['stopShipment']);
    expect(h.apiSource.cancelled).toHaveLength(1); // 취소 요청은 한 번만
  });

  it('공급처가 이미 발송 → 쿠팡 이미출고(송장) → 고객 반품 진행', async () => {
    const { vendorItemId, line, o, src } = await purchased();
    (src as any).cancelMode = 'request';
    claim({ receiptId: '503', marketOrderId: line.marketOrderId, vendorItemId, type: 'RETURN', stage: 'stop_requested' });
    await pollClaims(h.ctx);
    (src as any).ship(o.source_order_id, '612345678901', 'CJ대한통운');
    await cycle();
    const after = await orderByBox(h, line.shipmentBoxId);
    expect(after).toMatchObject({ status: 'TRACKING_UPLOADED', tracking_no: '612345678901', courier_code: 'CJGLS' });
    expect(h.market.claimActions).toEqual([{ action: 'markShippedForClaim', receiptId: '503', detail: { courierCode: 'CJGLS', trackingNo: '612345678901' } }]);
    expect(h.notifier.titles()).toContain('취소 요청 — 이미 발송되어 이미출고 처리');
    expect(h.market.invoices).toHaveLength(0); // 일반 송장 업로드는 하지 않음(이미출고로 처리)
    // 고객 반품 → 반품 완료
    h.market.setClaimStage('503', 'return_requested');
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('RETURN_REQUESTED');
    h.market.setClaimStage('503', 'return_done');
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('RETURNED');
  });

  it('공급처 자동 취소 실패 → 알림, [공급처 취소 완료] 누르면 출고중지완료 → 취소됨', async () => {
    const { vendorItemId, line, o, src } = await purchased();
    (src as any).cancelMode = 'fail';
    claim({ receiptId: '504', marketOrderId: line.marketOrderId, vendorItemId, type: 'RETURN', stage: 'stop_requested' });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCEL_REQUESTED');
    expect(h.notifier.titles()).toContain('공급처 자동 취소 실패');
    const [c] = await claimsOf(o.id);
    const r = await claimAction(h.ctx, o.id, c!.id, { action: 'source_cancelled' }, 'admin');
    expect(r.message).toContain('출고중지완료');
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCELLED');
    expect(h.market.claimActions.map((a) => a.action)).toEqual(['stopShipment']);
  });

  it('직접 구매한 공급처(도매꾹) → 사람에게 안내, [이미 발송됨] 송장 입력 → 이미출고', async () => {
    const { vendorItemId, line, o } = await purchased({ source: 'mockmanual' });
    claim({ receiptId: '505', marketOrderId: line.marketOrderId, vendorItemId, type: 'RETURN', stage: 'stop_requested' });
    await cycle();
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCEL_REQUESTED');
    expect(h.notifier.titles().filter((t) => t === '고객 취소 — 공급처 주문 취소 필요')).toHaveLength(1);
    const [c] = await claimsOf(o.id);
    await claimAction(h.ctx, o.id, c!.id, { action: 'shipped', courier: '롯데택배', trackingNo: '2345-6789-0123' }, 'admin');
    expect(h.market.claimActions[0]).toMatchObject({ action: 'markShippedForClaim', detail: { courierCode: 'HYUNDAI', trackingNo: '234567890123' } });
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('TRACKING_UPLOADED');
  });

  it('구매 전 주문(사람 구매 대기) 취소 → 출고중지완료 → 취소됨 + 이미 샀으면 취소하라는 알림', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h, { source: 'mockmanual' });
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('AWAITING_PURCHASE');
    claim({ receiptId: '506', marketOrderId: line.marketOrderId, vendorItemId, type: 'RETURN', stage: 'stop_requested' });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCELLED');
    expect(h.notifier.titles()).toContain('구매 전 고객 취소');
  });

  it('부분 취소(2개 중 1개) → 자동 처리하지 않고 확인 필요', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, qty: 2, paidAmount: 60000, orderedAt: h.clock.now() });
    await cycle();
    claim({ receiptId: '507', marketOrderId: line.marketOrderId, vendorItemId, type: 'RETURN', stage: 'stop_requested', count: 1 });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('MANUAL_REVIEW');
    expect(h.apiSource.cancelled).toHaveLength(0);
    expect(h.market.claimActions).toHaveLength(0);
    expect(h.notifier.titles()).toContain('부분 취소 요청');
  });

  it('고객이 취소 철회(공급처 취소 요청 전) → 이전 상태로 복구', async () => {
    const { vendorItemId, line, o, src } = await purchased({ source: 'mockmanual' });
    void src;
    claim({ receiptId: '508', marketOrderId: line.marketOrderId, vendorItemId, type: 'RETURN', stage: 'stop_requested' });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCEL_REQUESTED');
    h.market.setClaimStage('508', 'withdrawn');
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PURCHASED');
    expect((await claimsOf(o.id))[0]!.closed_at).not.toBeNull();
  });

  it('목록에서 사라진 열린 클레임은 단건 조회로 철회 확인', async () => {
    const { vendorItemId, line } = await purchased({ source: 'mockmanual' });
    claim({ receiptId: '509', marketOrderId: line.marketOrderId, vendorItemId, type: 'RETURN', stage: 'stop_requested' });
    await cycle();
    h.market.claims = [];
    h.market.getClaim = async () => ({ receiptId: '509', marketOrderId: '', type: 'RETURN', status: 'WITHDRAWN', stage: 'withdrawn', reason: '', requestedAt: new Date() });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PURCHASED');
  });
});

describe('결제완료 즉시취소·판매자 취소', () => {
  it('쿠팡 즉시취소(이미 환불)인데 공급처 주문이 있으면 공급처만 취소 → 취소됨(출고중지 호출 없음)', async () => {
    const { vendorItemId, line, o } = await purchased();
    claim({ receiptId: '601', marketOrderId: line.marketOrderId, vendorItemId, type: 'CANCEL', stage: 'cancelled' });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCELLED');
    expect(h.apiSource.cancelled).toEqual([o.source_order_id]);
    expect(h.market.claimActions).toHaveLength(0);
  });

  it('공급처 품절로 공급처가 취소 → [쿠팡 주문 취소(품절)] → 쿠팡 취소 + 취소됨', async () => {
    const { line, o, src } = await purchased();
    (src as any).orderStates.set(o.source_order_id, 'cancelled');
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('MANUAL_REVIEW');
    const r = await sellerCancel(h.ctx, o.id, 'stock', 'admin');
    expect(r.message).toContain('취소');
    expect(h.market.sellerCancels).toEqual([{ marketOrderId: line.marketOrderId, vendorItemId: o.vendor_item_id, qty: 1, reason: 'stock' }]);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCELLED');
    await expect(sellerCancel(h.ctx, o.id, 'stock', 'admin')).rejects.toThrow('취소할 수 없는 상태');
  });
});

describe('반품', () => {
  async function delivered() {
    const x = await purchased();
    (x.src as any).ship(x.o.source_order_id);
    await cycle();
    h.market.setStatus(x.line.shipmentBoxId, 'FINAL_DELIVERY');
    await cycle();
    expect((await orderByBox(h, x.line.shipmentBoxId)).status).toBe('DELIVERED');
    return x;
  }

  it('반품 접수 → 안내 1회(귀책·반품배송비) → 입고완료 → [반품 승인] → 반품완료 → 환불 정산 시 손익 기록', async () => {
    const { vendorItemId, line, o } = await delivered();
    claim({ receiptId: '701', marketOrderId: line.marketOrderId, vendorItemId, type: 'RETURN', stage: 'return_requested', faultBy: 'CUSTOMER', returnShippingCharge: -5000, reason: '단순변심' });
    await cycle();
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('RETURN_REQUESTED');
    const n = h.notifier.sent.filter((m) => m.title === '반품 요청');
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toContain('고객 부담 5,000원');
    h.market.setClaimStage('701', 'return_collected');
    await cycle();
    expect(h.notifier.titles()).toContain('반품 입고완료 — 승인하면 환불');
    const [c] = await claimsOf(o.id);
    await claimAction(h.ctx, o.id, c!.id, { action: 'approve_return' }, 'admin');
    expect(h.market.claimActions.map((a) => a.action)).toEqual(['confirmReturn']);
    const ret = await orderByBox(h, line.shipmentBoxId);
    expect(ret.status).toBe('RETURNED');
    // 환불 정산이 들어오면 손익 기록
    h.market.revenue.push({ marketOrderId: line.marketOrderId, vendorItemId, saleType: 'SALE', saleAmount: 30000, serviceFee: 3000, serviceFeeVat: 300, settlementAmount: 26700, deliverySettlement: 0, recognizedAt: '2026-10-14', raw: {} });
    h.market.revenue.push({ marketOrderId: line.marketOrderId, vendorItemId, saleType: 'REFUND', saleAmount: 30000, serviceFee: 3000, serviceFeeVat: 300, settlementAmount: 26700, deliverySettlement: 0, recognizedAt: '2026-10-14', raw: {} });
    h.clock.advanceMinutes(60 * 48);
    await reconcile(h.ctx);
    const settled = await orderByBox(h, line.shipmentBoxId);
    expect(settled.status).toBe('RETURNED');
    expect(settled.profit).toBe(-(settled.purchase_cost ?? 0) - (settled.purchase_shipping ?? 0));
  });

  it('반품 철회 → 배송완료로 복구', async () => {
    const { vendorItemId, line } = await delivered();
    claim({ receiptId: '702', marketOrderId: line.marketOrderId, vendorItemId, type: 'RETURN', stage: 'return_requested' });
    await cycle();
    h.market.setClaimStage('702', 'withdrawn');
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('DELIVERED');
  });
});

describe('교환·재발송', () => {
  it('교환 요청 → 안내 1회 → [공급처 재발송] → 송장 회신 알림 → 교환 완료 시 종료, 재발송 비용은 손익에서 차감', async () => {
    const { vendorItemId, line, o } = await purchased();
    claim({ receiptId: '801', marketOrderId: line.marketOrderId, vendorItemId, type: 'EXCHANGE', stage: 'exchange_open', reason: '사이즈 교환' });
    await cycle();
    await cycle();
    expect(h.notifier.titles().filter((t) => t === '교환 요청')).toHaveLength(1);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PURCHASED'); // 주문 상태는 그대로
    const r = await reshipOrder(h.ctx, o.id, 'admin');
    expect(r.message).toContain('재발송 주문');
    expect(h.apiSource.orders.size).toBe(2);
    await expect(reshipOrder(h.ctx, o.id, 'admin')).rejects.toThrow('이미 재발송');
    const [c] = await claimsOf(o.id);
    expect(c!.reship_source_order_id).toBeTruthy();
    expect((await orderByBox(h, line.shipmentBoxId)).extra_cost).toBe(c!.reship_cost);
    (h.apiSource as any).ship(c!.reship_source_order_id, '512345678901', '한진택배');
    await cycle();
    const n = h.notifier.sent.find((m) => m.title === '교환 재발송 송장 — Wing에 입력')!;
    expect(n.body).toContain('512345678901');
    h.market.setClaimStage('801', 'exchange_done');
    await cycle();
    expect((await claimsOf(o.id))[0]!.closed_at).not.toBeNull();
  });

  it('교환 접수 없이 재발송(분실·파손) → 재발송 기록 → 송장 회신되면 종료', async () => {
    const { o } = await purchased();
    await reshipOrder(h.ctx, o.id, 'admin');
    const [c] = await claimsOf(o.id);
    expect(c).toMatchObject({ claim_type: 'RESHIP', stage: 'exchange_open' });
    (h.apiSource as any).ship(c!.reship_source_order_id);
    await cycle();
    expect(h.notifier.titles()).toContain('재발송 송장');
    expect((await claimsOf(o.id))[0]!.closed_at).not.toBeNull();
  });
});

describe('모의 실행 보호', () => {
  it('주문 처리(LIVE_FULFILLMENT)가 꺼져 있으면 쿠팡 출고중지는 모의(실제 호출 없음)', async () => {
    h = await makeHarness({ live: false });
    const { vendorItemId } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    claim({ receiptId: '901', marketOrderId: line.marketOrderId, vendorItemId, type: 'RETURN', stage: 'stop_requested' });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCELLED');
    expect(h.market.claimActions).toHaveLength(0);
  });
});
