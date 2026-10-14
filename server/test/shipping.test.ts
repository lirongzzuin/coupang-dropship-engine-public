import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/config/settings.js';
import { resolveCourier } from '../src/modules/orders/couriers.js';
import { reconcileMarketState } from '../src/modules/monitor/service.js';
import { pollClaims, pollFulfillment, pollNewOrders, processPending, submitTracking } from '../src/modules/orders/service.js';
import { makeHarness, orderByBox, seedActiveListing, type TestHarness } from './helpers.js';

/** 실제 배송: 택배사 표기가 제각각인 공급처 송장을 쿠팡에 정확히 올리고, 배송이 멈추면 잡아낸다 */
let h: TestHarness;
afterEach(async () => h && (await h.close()));

async function cycle() {
  await pollNewOrders(h.ctx);
  await processPending(h.ctx);
  await pollClaims(h.ctx);
  await pollFulfillment(h.ctx);
}
async function purchasedOrder() {
  const { vendorItemId } = await seedActiveListing(h);
  const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
  await cycle();
  const o = await orderByBox(h, line.shipmentBoxId);
  expect(o.status).toBe('PURCHASED');
  return { line, o };
}

describe('택배사 → 쿠팡 코드', () => {
  const user = defaultSettings().orders.courierAliases;
  const code = (name: string, c?: string) => resolveCourier({ name, code: c }, user)?.code ?? null;
  it('공식 이름·약칭·옛 이름·법인 표기·공백', () => {
    expect(code('CJ대한통운')).toBe('CJGLS');
    expect(code('CJ 대한통운(주)')).toBe('CJGLS');
    expect(code('씨제이대한통운')).toBe('CJGLS');
    expect(code('대한통운')).toBe('CJGLS');
    expect(code('롯데택배')).toBe('HYUNDAI');
    expect(code('롯데글로벌로지스㈜')).toBe('HYUNDAI');
    expect(code('현대택배')).toBe('HYUNDAI');
    expect(code('한진')).toBe('HANJIN');
    expect(code('로젠택배')).toBe('KGB');
    expect(code('ILOGEN')).toBe('KGB');
    expect(code('우체국택배')).toBe('EPOST');
    expect(code('우체국 소포')).toBe('EPOST');
    expect(code('경동화물')).toBe('KDEXP');
    expect(code('대신화물')).toBe('DAESIN');
    expect(code('KG로지스')).toBe('DONGBU');
    expect(code('CU편의점택배')).toBe('BGF');
    expect(code('GS25 편의점택배')).toBe('CVS');
    expect(code('업체직송')).toBe('DIRECT');
    expect(code('직접배송')).toBe('DIRECT');
  });
  it('긴 이름 우선(우체국 EMS ≠ 우체국, 롯데글로벌로지스 = 롯데택배), 쿠팡 코드 그대로, 숫자 코드', () => {
    expect(code('우체국 EMS')).toBe('EMS');
    expect(code('HANJIN')).toBe('HANJIN');
    expect(code('cjgls')).toBe('CJGLS');
    expect(code('', '04')).toBe('CJGLS');
    expect(code('', '4')).toBe('CJGLS');
    expect(code('', '08')).toBe('HYUNDAI');
    expect(code('알수없음', '05')).toBe('HANJIN'); // 이름을 못 맞추면 공급처 코드로
  });
  it('모르는 택배사·임의 영문은 null(예전처럼 아무 대문자를 코드로 쓰지 않음)', () => {
    expect(code('없는택배')).toBeNull();
    expect(code('ABCXYZ')).toBeNull();
    expect(code('', '99')).toBeNull();
    expect(code('')).toBeNull();
  });
  it('관리자가 정한 별칭이 우선', () => {
    expect(resolveCourier({ name: '새벽배송K' }, { 새벽배송K: 'TEAMFRESH' })?.code).toBe('TEAMFRESH');
    expect(resolveCourier({ name: '한진' }, { 한진: 'HDEXP' })?.code).toBe('HDEXP');
  });
});

describe('공급처 송장 → 쿠팡 등록', () => {
  it('공급처 택배사 코드만 있어도 등록, 원래 표기 저장', async () => {
    h = await makeHarness({ live: true });
    const { o, line } = await purchasedOrder();
    h.apiSource.ship(o.source_order_id!, '612345678901', '', '04');
    await cycle();
    const after = await orderByBox(h, line.shipmentBoxId);
    expect(after).toMatchObject({ status: 'TRACKING_UPLOADED', courier_code: 'CJGLS', tracking_no: '612345678901' });
    expect(h.market.invoices[0]).toMatchObject({ courierCode: 'CJGLS', trackingNo: '612345678901' });
  });

  it('처음 보는 택배사 → 송장 저장·알림 1회 → 관리자가 택배사를 고르면 등록 + 기억 → 다음 주문은 자동', async () => {
    h = await makeHarness({ live: true });
    const a = await purchasedOrder();
    h.apiSource.ship(a.o.source_order_id!, '512345678901', '번개특송');
    await cycle();
    await cycle();
    let o = await orderByBox(h, a.line.shipmentBoxId);
    expect(o).toMatchObject({ status: 'PURCHASED', courier_code: null, courier_name: '번개특송', tracking_no: '512345678901' });
    expect(o.invoice_error).toContain('택배사 확인 필요');
    expect(h.notifier.titles().filter((t) => t === '택배사 선택 필요')).toHaveLength(1);
    expect(h.market.invoices).toHaveLength(0);
    // 관리자: 공급처 주문 화면 확인 후 '한진택배' 선택
    await submitTracking(h.ctx, o.id, '번개특송', '512345678901', 'admin', { courierCode: 'HANJIN' });
    o = await orderByBox(h, a.line.shipmentBoxId);
    expect(o).toMatchObject({ status: 'TRACKING_UPLOADED', courier_code: 'HANJIN', invoice_error: null });
    expect((await h.ctx.settings.get()).orders.courierAliases['번개특송']).toBe('HANJIN');
    // 다음 주문은 사람 손 없이
    const b = await purchasedOrder();
    h.apiSource.ship(b.o.source_order_id!, '512345678902', '번개 특송');
    await cycle();
    expect((await orderByBox(h, b.line.shipmentBoxId)).status).toBe('TRACKING_UPLOADED');
    expect(h.market.invoices.at(-1)).toMatchObject({ courierCode: 'HANJIN', trackingNo: '512345678902' });
  });

  it('쿠팡이 송장 형식을 거절(재시도형) → 3회째 알림 1번 → 공급처가 송장을 고치면 자동 등록', async () => {
    h = await makeHarness({ live: true });
    const { o, line } = await purchasedOrder();
    h.apiSource.ship(o.source_order_id!, '12-34', 'CJ대한통운'); // 형식 오류(가짜 쿠팡: 8~14자리)
    for (let i = 0; i < 4; i++) await cycle();
    let after = await orderByBox(h, line.shipmentBoxId);
    expect(after.status).toBe('PURCHASED');
    expect(after.invoice_attempts).toBe(4);
    expect(after.invoice_error).toContain('INVALID_INVOICE_NUMBER');
    const n = h.notifier.sent.filter((m) => m.title === '송장 등록 반복 실패');
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toContain('형식');
    h.apiSource.ship(o.source_order_id!, '612345678901', 'CJ대한통운');
    await cycle();
    after = await orderByBox(h, line.shipmentBoxId);
    expect(after).toMatchObject({ status: 'TRACKING_UPLOADED', tracking_no: '612345678901', invoice_attempts: 0, invoice_error: null });
  });

  it('고객 취소 진행 중(출고중지요청)이면 송장 거절을 오류로 보지 않음 → 취소 흐름이 처리', async () => {
    h = await makeHarness({ live: true });
    const { o, line } = await purchasedOrder();
    h.market.uploadInvoice = async () => ({ ok: false, retryable: false, message: 'ORDER_DELIVERY_CANCELED: 취소된 주문' });
    h.apiSource.ship(o.source_order_id!, '612345678901');
    await pollFulfillment(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PURCHASED');
    expect(h.notifier.titles()).not.toContain('송장 업로드 실패');
  });
});

describe('송장 등록 후 배송 감시', () => {
  it('공급처가 송장을 고침 → 쿠팡 송장 수정(배송지시 상태), 계속 안 움직이면 72시간 뒤 알림 1회', async () => {
    h = await makeHarness({ live: true });
    const { o, line } = await purchasedOrder();
    h.apiSource.ship(o.source_order_id!, '612345678901', 'CJ대한통운');
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('TRACKING_UPLOADED');
    // 12시간 안에는 공급처 재확인 안 함
    h.apiSource.ship(o.source_order_id!, '412345678901', '롯데택배');
    h.clock.advanceMinutes(60 * 6);
    await pollFulfillment(h.ctx);
    expect(h.market.invoiceUpdates).toHaveLength(0);
    h.clock.advanceMinutes(60 * 7);
    await pollFulfillment(h.ctx);
    expect(h.market.invoiceUpdates).toEqual([expect.objectContaining({ courierCode: 'HYUNDAI', trackingNo: '412345678901' })]);
    let after = await orderByBox(h, line.shipmentBoxId);
    expect(after).toMatchObject({ courier_code: 'HYUNDAI', tracking_no: '412345678901', status: 'TRACKING_UPLOADED' });
    expect(h.notifier.titles()).toContain('송장 수정 반영');
    // 그 뒤로도 배송 시작이 안 잡힘 → 72시간 넘으면 1회 알림
    for (let i = 0; i < 14; i++) {
      h.clock.advanceMinutes(60 * 6);
      await pollFulfillment(h.ctx);
    }
    expect(h.notifier.titles().filter((t) => t === '배송 조회가 안 돼요')).toHaveLength(1);
    // 배송 시작 → 배송중 → 배송완료
    h.market.setStatus(line.shipmentBoxId, 'DELIVERING');
    await pollFulfillment(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('IN_TRANSIT');
    h.market.setStatus(line.shipmentBoxId, 'FINAL_DELIVERY');
    await pollFulfillment(h.ctx);
    after = await orderByBox(h, line.shipmentBoxId);
    expect(after.status).toBe('DELIVERED');
    expect(h.market.invoiceUpdates).toHaveLength(1);
  });

  it('업체직송(DIRECT)은 배송조회가 없으니 정체 알림 안 함', async () => {
    h = await makeHarness({ live: true });
    const { o, line } = await purchasedOrder();
    h.apiSource.ship(o.source_order_id!, '1234567890', '업체직송');
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).courier_code).toBe('DIRECT');
    for (let i = 0; i < 20; i++) {
      h.clock.advanceMinutes(60 * 6);
      await pollFulfillment(h.ctx);
    }
    expect(h.notifier.titles()).not.toContain('배송 조회가 안 돼요');
  });

  it('자동 발주가 되면 알림(새 주문 — 자동 발주 완료)', async () => {
    h = await makeHarness({ live: true });
    await purchasedOrder();
    const n = h.notifier.sent.find((m) => m.title === '새 주문 — 자동 발주 완료')!;
    expect(n.body).toContain('예상 이익');
  });
});

describe('취소 중 공급사 거절', () => {
  it('취소 요청 후 공급처가 다시 준비중으로 → 거절 알림 1회 → 그대로 발송되면 이미출고 처리', async () => {
    h = await makeHarness({ live: true });
    const { o, line } = await purchasedOrder();
    (h.apiSource as any).cancelMode = 'request';
    h.market.claim({ receiptId: '991', marketOrderId: line.marketOrderId, vendorItemId: o.vendor_item_id, type: 'RETURN', stage: 'stop_requested', requestedAt: h.clock.now() });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCEL_REQUESTED');
    h.apiSource.orderStates.set(o.source_order_id!, 'ok'); // 공급사가 취소 거절
    await cycle();
    await cycle();
    expect(h.notifier.titles().filter((t) => t === '공급처가 취소를 거절했어요')).toHaveLength(1);
    h.apiSource.ship(o.source_order_id!, '612345678901', 'CJ대한통운');
    await cycle();
    expect(h.market.claimActions.map((x) => x.action)).toEqual(['markShippedForClaim']);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('TRACKING_UPLOADED');
  });
});

describe('쿠팡 삭제 정리 알림', () => {
  it('이미 삭제로 정리한 상품은 다음 대조에서 다시 알리지 않음', async () => {
    h = await makeHarness({ live: true });
    const x = await seedActiveListing(h);
    await h.ctx.db.updateTable('listings').set({ dry_run: false }).where('id', '=', x.listing.id).execute();
    h.market.items.get(x.vendorItemId)!.onSale = false;
    h.market.deletedInWing.add(x.listing.seller_product_id!);
    expect((await reconcileMarketState(h.ctx)).deleted).toBe(1);
    h.clock.advanceMinutes(60);
    expect((await reconcileMarketState(h.ctx)).deleted ?? 0).toBe(0);
    h.clock.advanceMinutes(60);
    await reconcileMarketState(h.ctx);
    expect(h.notifier.titles().filter((t) => t.startsWith('쿠팡에서 삭제한 상품'))).toHaveLength(1);
  });
});
