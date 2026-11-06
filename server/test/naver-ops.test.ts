import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { DryRunMarket } from '../src/adapters/dryRunMarket.js';
import { NaverCommerceClient, NaverMarket, parseClaim } from '../src/adapters/naver/commerce.js';
import { loadEnv } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { refreshListingStatuses } from '../src/modules/listing/service.js';
import { naverMirror } from '../src/modules/naver/mirror.js';
import { reconcileNaver } from '../src/modules/naver/reconcile.js';
import { pollInquiries } from '../src/modules/cs/service.js';
import { reshipOrder } from '../src/modules/orders/claims.js';
import { checkDelays, pollClaims, pollFulfillment, pollNewOrders, processPending } from '../src/modules/orders/service.js';
import { watchdog } from '../src/modules/reports/service.js';
import { runSelection } from '../src/modules/selection/service.js';
import type { CategoryMeta } from '../src/ports/market.js';
import type { SourceOption } from '../src/ports/source.js';
import { FakeMarket } from '../src/adapters/fake/fakeMarket.js';
import { makeHarness, orderByBox, TEST_ENV_BASE, type TestHarness, logged } from './helpers.js';

/** 스마트스토어 실운영 점검: 쿠팡과 같은 흐름 + 스마트스토어 전용 기능 */
const log = createLogger('silent');
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

function mockApi(handler: (method: string, path: string, body: any, url: URL) => Response) {
  const calls: Array<{ method: string; path: string; body: any; query: string }> = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace('/external', '');
    if (path === '/v1/oauth2/token') return json({ access_token: 't', expires_in: 10800 });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', path, body, query: url.search });
    return handler(init?.method ?? 'GET', path, body, url);
  }) as unknown as typeof fetch;
  const market = new NaverMarket(new NaverCommerceClient({ clientId: 'A', clientSecret: bcrypt.genSaltSync(4), logger: log, fetchImpl, retryBaseMs: 1, requestsPerSecond: 1000 }));
  return { market, calls };
}
const row = (po: Record<string, any> = {}) => ({
  order: { orderId: 'ORD1', paymentDate: '2026-10-17T10:00:00.000+09:00' },
  productOrder: { productOrderId: 'PO1', productOrderStatus: 'PAYED', placeOrderStatus: 'NOT_YET', quantity: 1, totalPaymentAmount: 12900, originalProductId: '900', optionManageCode: 'NVI5', shippingAddress: { name: '김철수', tel1: '010-2222-3333', baseAddress: '부산 해운대구 1', detailedAddress: '2층', zipCode: '48000' }, ...po },
});

describe('스마트스토어 어댑터(실운영 보완)', () => {
  it('새 주문: 결제 직후 배송지를 바꿔 마지막 변경이 "배송지 변경"인 주문도 수집', async () => {
    const api = mockApi((_m, path) => {
      if (path.endsWith('/last-changed-statuses')) return json({ data: { lastChangeStatuses: [{ productOrderId: 'PO1', lastChangedType: 'DELIVERY_ADDRESS_CHANGED', receiverAddressChanged: true }] } });
      return json({ data: [row()] });
    });
    expect((await api.market.listOrders(new Date('2026-10-17T00:00:00Z'), new Date('2026-10-17T02:00:00Z'), 'ACCEPT')).map((l) => l.shipmentBoxId)).toEqual(['PO1']);
    expect((await api.market.listAddressChanges(new Date('2026-10-17T00:00:00Z'), new Date('2026-10-17T02:00:00Z')))[0]!.receiver.addr1).toBe('부산 해운대구 1');
  });

  it('송장 오류 코드 → 공통 사유(재시도·안내 규칙 공유), 발송 지연·교환 재배송 요청 형식', async () => {
    let failCode = '104122';
    const api = mockApi((_m, path) => {
      if (path.endsWith('/dispatch') && !path.includes('/claim/')) return json({ data: { successProductOrderIds: [], failProductOrderInfos: [{ productOrderId: 'PO1', code: failCode, message: '송장 오류' }] } });
      return json({ data: { successProductOrderIds: ['PO1'], failProductOrderInfos: [] } });
    });
    const inv = { shipmentBoxId: 'PO1', marketOrderId: 'ORD1', vendorItemId: 'NV900:5', courierCode: 'CJGLS', trackingNo: '612345678901' };
    expect(await api.market.uploadInvoice(inv)).toMatchObject({ ok: false, retryable: true, message: 'INVALID_INVOICE_NUMBER(104122): 송장 오류' });
    failCode = '104121';
    expect(await api.market.uploadInvoice(inv)).toMatchObject({ ok: false, retryable: true, message: expect.stringMatching(/^DUPLICATE_INVOICE_NUMBER/) });
    failCode = '104119';
    expect(await api.market.uploadInvoice(inv)).toMatchObject({ ok: false, retryable: false, message: expect.stringMatching(/^INVALID_FORMAT/) });
    expect((await api.market.delayDispatch('PO1', new Date('2026-10-20T14:59:00Z'), '공급처 출고 준비 중')).ok).toBe(true);
    expect(api.calls.at(-1)).toMatchObject({ path: '/v1/pay-order/seller/product-orders/PO1/delay', body: { dispatchDueDate: '2026-10-20T23:59:00.000+09:00', delayedDispatchReason: 'PRODUCT_PREPARE' } });
    expect((await api.market.redeliverExchange('PO1:EXCHANGE', 'HANJIN', '512345678901')).ok).toBe(true);
    expect(api.calls.slice(-2).map((c) => c.path)).toEqual(['/v1/pay-order/seller/product-orders/PO1/claim/exchange/collect/approve', '/v1/pay-order/seller/product-orders/PO1/claim/exchange/dispatch']);
    expect(api.calls.at(-1)!.body).toEqual({ reDeliveryMethod: 'DELIVERY', reDeliveryCompany: 'HANJIN', reDeliveryTrackingNumber: '512345678901' });
  });

  it('문의: 상품 문의(Q&A)와 주문 1:1 문의를 함께 수집, 답변은 종류별 API로', async () => {
    const api = mockApi((_m, path) => {
      if (path === '/v1/contents/qnas') return json({ contents: [{ questionId: 77, question: '배송 언제 되나요?', productName: '정리함', createDate: '2026-10-17T09:00:00+09:00', answered: false }], last: true });
      if (path === '/v1/pay-user/inquiries') return json({ content: [{ inquiryNo: 88, category: '배송', title: '배송문의', inquiryContent: '언제 와요', inquiryRegistrationDateTime: '2026-10-17T09:30:00.000+09:00', answered: false }], last: true });
      return json({});
    });
    const list = await api.market.listInquiries(new Date('2026-10-16T00:00:00Z'), new Date('2026-10-17T03:00:00Z'));
    expect(list.map((q) => [q.kind, q.inquiryId])).toEqual([['product', '77'], ['order', '88']]);
    await api.market.replyInquiry({ inquiryId: '77', kind: 'product' }, '내일 출고됩니다');
    expect(api.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/v1/contents/qnas/77', body: { commentContent: '내일 출고됩니다' } });
    await api.market.replyInquiry({ inquiryId: '88', kind: 'order' }, '내일 출고됩니다');
    expect(api.calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/pay-merchant/inquiries/88/answer', body: { answerComment: '내일 출고됩니다' } });
  });

  it('같은 상품의 옵션을 연달아 확인하면 상품 조회는 한 번(30초 캐시), 수정하면 캐시를 지움', async () => {
    const product = { originProduct: { statusType: 'SALE', salePrice: 10000, detailAttribute: { optionInfo: { optionCombinations: [
      { id: 1, stockQuantity: 10, price: 0, usable: true, sellerManagerCode: 'NVI1' }, { id: 2, stockQuantity: 5, price: 500, usable: true, sellerManagerCode: 'NVI2' },
    ] } } } };
    const api = mockApi((m, path) => (m === 'GET' && path === '/v2/products/origin-products/900' ? json(product) : json({})));
    await api.market.updateQuantity('NV900:1', 10);
    await api.market.updateQuantity('NV900:2', 5);
    expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    await api.market.updateQuantity('NV900:2', 3); // 수정 → 캐시 삭제
    await api.market.updateQuantity('NV900:1', 10); // 수정 뒤라 다시 조회
    expect(api.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('반품 클레임: 고객에게 청구한 반품 배송비(고객 부담)·수거 방법', () => {
    const c = parseClaim({ ...row({ claimType: 'RETURN', claimStatus: 'RETURN_REQUEST' }), currentClaim: { return: { returnReason: 'INTENT_CHANGED', claimDeliveryFeeDemandAmount: 6000, collectDeliveryMethod: 'RETURN_DESIGNATED', requestQuantity: 1 } } })!;
    expect(c).toMatchObject({ stage: 'return_requested', returnShippingCharge: -6000, pickupType: '지정 반품택배(자동 수거)', count: 1 });
  });

  it('쿠팡에는 없는 기능(발송 지연·교환 재배송)은 모의 실행 래퍼도 노출하지 않음(가짜 성공 방지)', () => {
    const env = loadEnv({ ...TEST_ENV_BASE });
    const coupang = new DryRunMarket(new FakeMarket(), env, log);
    expect(coupang.delayDispatch).toBeUndefined();
    expect(coupang.redeliverExchange).toBeUndefined();
    const naver = new DryRunMarket(new FakeMarket('naver'), env, log);
    expect(typeof naver.delayDispatch).toBe('function');
  });
});

// ── 통합 ──────────────────────────────────────────────────────────────────

const COUPANG = { vendorUserId: 'w', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588-0000', returnZipCode: '04524', returnAddress: '서울' };
const META: CategoryMeta = {
  code: '1', notices: [], requiredAttributes: ['색상', '사이즈', '수량'], attributeNames: ['색상', '사이즈', '수량'],
  requiredAttributeSpecs: [{ name: '색상', dataType: 'STRING' }, { name: '사이즈', dataType: 'STRING' }, { name: '수량', dataType: 'NUMBER', basicUnit: '개', usableUnits: ['개'] }],
};
const opt = (color: string, size: string, price: number, stock: number | null = 50): SourceOption => ({ name: `${color} / ${size}`, price, stock, attrs: [{ name: '색상', value: color }, { name: '사이즈', value: size }] });

let h: TestHarness;
afterEach(async () => h && (await h.close()));

async function cycle() {
  await pollNewOrders(h.ctx);
  await processPending(h.ctx);
  await pollClaims(h.ctx);
  await pollFulfillment(h.ctx);
}

/** 쿠팡 판매 상품 → 스마트스토어 판매중 → 스마트스토어 주문 1건(구매완료까지) */
async function naverOrder() {
  h = await makeHarness({ live: true, naver: true });
  await h.ctx.settings.update({ coupang: COUPANG, naver: { enabled: true } });
  h.market.getCategoryMeta = async () => META;
  h.apiSource.add({ sourceItemId: 'V1', title: '논슬립 수납 정리함', price: 8000, stock: 200, categoryPath: '생활/건강>수납/정리용품>수납함', options: [opt('화이트', 'M', 8000), opt('블랙', 'L', 9000)] });
  h.marketData.volume.set('수납 정리함', 20000);
  h.marketData.lowest.set('수납 정리함', 40000);
  await runSelection(h.ctx, { keywords: ['수납 정리함'] });
  h.market.autoApprove = true;
  await refreshListingStatuses(h.ctx);
  await naverMirror(h.ctx);
  h.naver.autoApprove = true;
  await refreshListingStatuses(h.ctx);
  const nl = await h.ctx.db.selectFrom('listings').selectAll().where('market', '=', 'naver').executeTakeFirstOrThrow();
  const item = (await h.ctx.db.selectFrom('listing_items').selectAll().where('listing_id', '=', nl.id).execute()).find((i) => i.unit_qty === 1)!;
  const shipBy = '2026-10-15';
  const line = h.naver.seedOrder({ vendorItemId: item.vendor_item_id!, paidAmount: item.sale_price, orderedAt: h.clock.now(), shipBy });
  await cycle();
  const o = await orderByBox(h, line.shipmentBoxId);
  expect(o).toMatchObject({ market: 'naver', status: 'PURCHASED', ship_by: shipBy });
  return { nl, item, line, o };
}

describe('스마트스토어 전용 운영', () => {
  it('발송 기한 당일까지 송장이 없으면 발송 지연 처리(2일) → 기한 갱신·알림, 주문당 최대 2번, 쿠팡 주문은 대상 아님', async () => {
    const { line, o } = await naverOrder();
    h.clock.advanceMinutes(60 * 24); // 10-14 10:00
    await checkDelays(h.ctx);
    expect(h.naver.delays).toHaveLength(0); // 기한 전날
    h.clock.advanceMinutes(60 * 24); // 10-15(기한 당일)
    await checkDelays(h.ctx);
    expect(h.naver.delays).toHaveLength(1);
    expect(h.naver.delays[0]!.dueDate.toISOString()).toBe('2026-10-17T14:59:00.000Z'); // 10-17 23:59 KST
    let cur = await orderByBox(h, line.shipmentBoxId);
    expect(cur.ship_by).toBe('2026-10-17');
    expect((await logged(h.ctx)).map((x) => x.title)).toContain('스마트스토어 발송 지연 처리');
    await checkDelays(h.ctx);
    expect(h.naver.delays).toHaveLength(1); // 새 기한 전에는 다시 안 함
    h.clock.advanceMinutes(60 * 48);
    await checkDelays(h.ctx);
    h.clock.advanceMinutes(60 * 48);
    await checkDelays(h.ctx);
    expect(h.naver.delays).toHaveLength(2); // 최대 2번
    // 송장이 나오면 정상 발송 처리
    h.apiSource.ship(o.source_order_id!, '612345678901');
    await pollFulfillment(h.ctx);
    cur = await orderByBox(h, line.shipmentBoxId);
    expect(cur.status).toBe('TRACKING_UPLOADED');
  });

  it('고객이 배송지 변경 → 새 주소 저장 + 공급처 주문도 바꾸라는 알림(1번)', async () => {
    const { line, o } = await naverOrder();
    const changed = { ...h.naver.orders.get(line.shipmentBoxId)![0]!, receiver: { name: '김영희', phone: '010-9999-8888', addr1: '대전 유성구 2', addr2: '301호', zip: '34000' } };
    h.naver.addressChanges = [changed];
    await pollNewOrders(h.ctx);
    await pollNewOrders(h.ctx);
    const after = await orderByBox(h, line.shipmentBoxId);
    expect(after.address_hash).not.toBe(o.address_hash);
    const { decryptReceiver } = await import('../src/modules/orders/service.js');
    expect(decryptReceiver(h.ctx, after)).toMatchObject({ name: '김영희', addr1: '대전 유성구 2' });
    expect(h.notifier.titles().filter((t) => t === '배송지 변경 — 공급처 주문도 수정하세요')).toHaveLength(1);
    const ev = await h.ctx.db.selectFrom('order_events').select('reason').where('order_id', '=', o.id).execute();
    expect(ev.some((e) => e.reason?.includes('배송지 변경'))).toBe(true);
  });

  it('취소 요청 중 공급처가 발송 → 일반 송장 대신 취소 흐름이 발송 처리(취소 거부)·반품 진행', async () => {
    const { line, o, item } = await naverOrder();
    (h.apiSource as any).cancelMode = 'request';
    h.naver.claim({ receiptId: `${line.shipmentBoxId}:CANCEL`, marketOrderId: line.marketOrderId, vendorItemId: item.vendor_item_id!, type: 'CANCEL', stage: 'stop_requested', requestedAt: h.clock.now() });
    await pollClaims(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCEL_REQUESTED');
    h.apiSource.ship(o.source_order_id!, '612345678901');
    await cycle();
    expect(h.naver.invoices).toHaveLength(0);
    expect(h.naver.claimActions.map((a) => a.action)).toEqual(['markShippedForClaim']);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('TRACKING_UPLOADED');
  });

  it('교환: [공급처 재발송] → 송장이 오면 스마트스토어 교환 재배송까지 자동(수동 입력 불필요)', async () => {
    const { line, o, item } = await naverOrder();
    h.apiSource.ship(o.source_order_id!, '612345678901');
    await cycle();
    h.naver.claim({ receiptId: `${line.shipmentBoxId}:EXCHANGE`, marketOrderId: line.marketOrderId, vendorItemId: item.vendor_item_id!, type: 'EXCHANGE', stage: 'exchange_open', requestedAt: h.clock.now() });
    await pollClaims(h.ctx);
    await reshipOrder(h.ctx, o.id, 'admin');
    const c = await h.ctx.db.selectFrom('order_claims').selectAll().where('order_id', '=', o.id).executeTakeFirstOrThrow();
    h.apiSource.ship(c.reship_source_order_id!, '512345678901', '한진택배');
    await pollClaims(h.ctx);
    expect(h.naver.redeliveries).toEqual([{ receiptId: `${line.shipmentBoxId}:EXCHANGE`, courierCode: 'HANJIN', trackingNo: '512345678901' }]);
    expect((await logged(h.ctx)).map((x) => x.title)).toContain('교환 재배송 처리');
    expect(h.notifier.titles()).not.toContain('교환 재발송 송장 — 스마트스토어센터에 입력');
  });

  it('구매확정 정산으로 실제 수수료율 학습(가격 계산에 반영)', async () => {
    const { line, o, nl } = await naverOrder();
    h.apiSource.ship(o.source_order_id!, '612345678901');
    await cycle();
    h.naver.setStatus(line.shipmentBoxId, 'FINAL_DELIVERY');
    for (const l of h.naver.orders.get(line.shipmentBoxId)!) Object.assign(l, { decided: true, settlementAmount: Math.round(o.sale_amount * 0.95) });
    await pollFulfillment(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('SETTLED');
    const after = await h.ctx.db.selectFrom('listings').select('fee_rate_actual').where('id', '=', nl.id).executeTakeFirstOrThrow();
    expect(after.fee_rate_actual).toBeCloseTo(0.07 * 0.7 + 0.05 * 0.3, 3);
  });

  it('판매상태 대조: 스마트스토어센터에서 삭제 → 판매종료, 판매금지·판매중지 → 일시중지(자동 재개 안 함), 우리가 멈춘 상품이 판매중이면 다시 중지', async () => {
    const { nl } = await naverOrder();
    const p = h.naver.products.get(nl.seller_product_id!)!;
    (p as any).status = 'SUSPENSION';
    let r = await reconcileNaver(h.ctx);
    expect(r.stopped).toBe(1);
    let l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', nl.id).executeTakeFirstOrThrow();
    expect(l).toMatchObject({ status: 'paused' });
    expect(l.status_reason).toMatch(/^스마트스토어에서 판매중지됨/);
    (p as any).status = 'PROHIBITION';
    r = await reconcileNaver(h.ctx);
    l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', nl.id).executeTakeFirstOrThrow();
    expect(l.status_reason).toMatch(/^스마트스토어 판매금지/);
    h.naver.deletedInWing.add(nl.seller_product_id!);
    r = await reconcileNaver(h.ctx);
    expect(r.deleted).toBe(1);
    l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', nl.id).executeTakeFirstOrThrow();
    expect(l).toMatchObject({ status: 'stopped', status_reason: '스마트스토어에서 삭제됨' });
    expect((await logged(h.ctx)).map((x) => x.title).filter((t) => t.startsWith('스마트스토어 판매상태 변경'))).toHaveLength(3);
  });

  it('문의: 스마트스토어 상품 문의·주문 문의 모두 수집·자동 답변(쿠팡 고객센터용 긴급 알림 아님)', async () => {
    h = await makeHarness({ live: true, naver: true });
    await h.ctx.settings.update({ naver: { enabled: true } });
    h.naver.inquiries.push({ inquiryId: '77', kind: 'product', content: '배송 언제 되나요?', askedAt: h.clock.now(), answered: false });
    h.naver.inquiries.push({ inquiryId: '88', kind: 'order', content: '배송 언제 와요', askedAt: h.clock.now(), answered: false });
    const r = await pollInquiries(h.ctx);
    expect(r.fetched).toBe(2);
    expect(h.naver.replies.map((x) => x.inquiryId).sort()).toEqual(['77', '88']);
    expect(h.notifier.titles()).not.toContain('쿠팡 고객센터 문의(급함)');
    const rows = await h.ctx.db.selectFrom('inquiries').select(['market', 'kind', 'status']).execute();
    expect(rows).toEqual(expect.arrayContaining([{ market: 'naver', kind: 'product', status: 'answered' }, { market: 'naver', kind: 'order', status: 'answered' }]));
  });

  it('감시: 스마트스토어 주문 수집이 멈추면 급한 알림(사용 중일 때만)', async () => {
    h = await makeHarness({ live: true, naver: true });
    await h.ctx.settings.update({ naver: { enabled: true } });
    await pollNewOrders(h.ctx);
    h.naver.failNext.set('listOrders', 100);
    h.clock.advanceMinutes(60);
    await pollNewOrders(h.ctx).catch(() => undefined);
    await watchdog(h.ctx);
    expect(h.notifier.titles()).toContain('주문 수집이 멈췄습니다(스마트스토어)');
    expect(h.notifier.titles()).not.toContain('주문 수집이 멈췄습니다'); // 쿠팡은 정상
  });
});
