import { afterEach, describe, expect, it } from 'vitest';
import { CoupangClient } from '../src/adapters/coupang/client.js';
import { OwnerclanSource } from '../src/adapters/ownerclan/source.js';
import { createLogger } from '../src/lib/logger.js';
import { pauseListing } from '../src/modules/listing/control.js';
import { confirmPurchase, pollClaims, pollFulfillment, pollNewOrders, processPending, resolveCourierCode, submitTracking } from '../src/modules/orders/service.js';
import { makeHarness, orderByBox, seedActiveListing, type TestHarness } from './helpers.js';

/**
 * 실전 전환 점검: 실제 쿠팡 상품에 들어온 실제 주문은 어떤 스위치 조합에서도
 * "모의 처리"로 사라지면 안 된다(아무도 안 사는 사고). 공급처 결제·취소도 자동 감지.
 */
const log = createLogger('silent');
let h: TestHarness;
afterEach(async () => h && (await h.close()));

const real = (env: Record<string, string>) => makeHarness({ live: false, env: { DRY_RUN: 'false', ...env } });

async function realListing() {
  const r = await seedActiveListing(h);
  await h.ctx.db.updateTable('listings').set({ dry_run: false }).where('id', '=', r.listing.id).execute();
  return r;
}

async function cycle() {
  await pollNewOrders(h.ctx);
  await processPending(h.ctx);
  await pollClaims(h.ctx);
  await pollFulfillment(h.ctx);
}

describe('실제 주문은 모의 처리 금지', () => {
  it('등록만 켜고(LIVE_LISTING) 주문 처리가 꺼져 있으면 → 구매 필요 + 할 일 알림, 쿠팡·공급처 호출 없음', async () => {
    h = await real({ LIVE_LISTING: 'true' });
    const { vendorItemId } = await realListing();
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    const o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('AWAITING_PURCHASE');
    expect(o.status_reason).toContain('LIVE_FULFILLMENT');
    expect(o.source_order_id).toBeNull();
    expect(h.market.calls).not.toContain('acknowledge');
    expect(h.apiSource.orders.size).toBe(0);
    const n = h.notifier.sent.find((m) => m.title === '실제 주문 — 직접 처리 필요')!;
    expect(n.body).toContain('Wing');
    // 사람이 오너클랜에서 사고 원주문번호 입력 → 송장은 Wing에 직접(자동 등록 꺼짐) → 모의 업로드 금지
    await confirmPurchase(h.ctx, o.id, { sourceOrderId: 'OC-REAL-1', cost: 15000 }, 'admin');
    const t = await submitTracking(h.ctx, o.id, 'CJ대한통운', '1234-5678-9012', 'admin');
    expect(t.status).toBe('MANUAL_REVIEW');
    expect(h.market.invoices).toHaveLength(0);
    expect(h.notifier.titles()).toContain('송장 직접 입력 필요');
  });

  it('주문 처리는 켜고 자동 발주(LIVE_ORDERING)만 꺼져 있으면 → 상품준비중은 실제 처리, 발주는 사람에게', async () => {
    h = await real({ LIVE_LISTING: 'true', LIVE_FULFILLMENT: 'true' });
    const { vendorItemId } = await realListing();
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    const o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('AWAITING_PURCHASE');
    expect(o.status_reason).toContain('LIVE_ORDERING');
    expect(h.market.calls).toContain('acknowledge');
    expect(h.apiSource.orders.size).toBe(0);
    // 이후 사람이 구매 확인 → 송장은 자동 업로드(LIVE_FULFILLMENT 켜짐)
    await confirmPurchase(h.ctx, o.id, { sourceOrderId: 'OC-REAL-2', cost: 15000 }, 'admin');
    expect((await submitTracking(h.ctx, o.id, 'CJ대한통운', '123456789012', 'admin')).status).toBe('TRACKING_UPLOADED');
    expect(h.market.invoices).toHaveLength(1);
  });

  it('모두 켜면(실전) 사람 개입 없이 발주까지', async () => {
    h = await real({ LIVE_LISTING: 'true', LIVE_FULFILLMENT: 'true', LIVE_ORDERING: 'true' });
    const { vendorItemId } = await realListing();
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PURCHASED');
    expect(h.apiSource.orders.size).toBe(1);
  });

  it('실등록만 켜도 실제 쿠팡 상품의 판매중지·가격·재고는 실제로 반영(품절 주문·역마진 방지)', async () => {
    h = await real({ LIVE_LISTING: 'true' });
    const { listing } = await realListing();
    expect(await pauseListing(h.ctx, listing, '공급처 품절')).toBe(true);
    expect(h.market.items.get(listing.vendor_item_id!)!.onSale).toBe(false);
    await h.ctx.market.updatePrice(listing.vendor_item_id!, 33000);
    expect(h.market.items.get(listing.vendor_item_id!)!.price).toBe(33000);
    // 모의 등록 상품(DRYVI)은 여전히 실제 호출 안 함
    expect((await h.ctx.market.stopSale('DRYVI-1-1')).dryRun).toBe(true);
  });
});

describe('공급처 결제·취소 자동 감지', () => {
  it('결제 대기 주문 → 오너클랜에서 결제되면 자동으로 구매완료 → 송장 자동 등록', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h);
    h.apiSource.needsPayment = true;
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    let o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('PAYMENT_PENDING');
    await pollFulfillment(h.ctx); // 아직 미결제 → 그대로
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PAYMENT_PENDING');
    h.apiSource.orderStates.set(o.source_order_id!, 'ok'); // 사용자가 예치금 결제
    h.apiSource.ship(o.source_order_id!);
    await pollFulfillment(h.ctx);
    await pollFulfillment(h.ctx);
    o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('TRACKING_UPLOADED');
  });

  it('공급사가 주문을 취소(품절) → 확인 필요 + 상품 판매중지 + 알림', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId, listing } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    const o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('PURCHASED');
    h.apiSource.orderStates.set(o.source_order_id!, 'cancelled');
    await pollFulfillment(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('MANUAL_REVIEW');
    expect((await h.ctx.db.selectFrom('listings').select('status').where('id', '=', listing.id).executeTakeFirstOrThrow()).status).toBe('paused');
    expect(h.notifier.titles()).toContain('공급처가 주문을 취소했어요');
  });

  it('구매 후 고객 취소(출고중지요청) → 공급처 주문 자동 취소 확인 → 쿠팡 출고중지완료 → 취소됨', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    const o = await orderByBox(h, line.shipmentBoxId);
    h.market.claims.push({ receiptId: 'c1', marketOrderId: line.marketOrderId, vendorItemId, type: 'CANCEL', status: 'RU', reason: '단순변심', requestedAt: h.clock.now() });
    await pollClaims(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCELLED');
    expect(h.apiSource.cancelled).toEqual([o.source_order_id]);
    expect(h.market.claimActions).toEqual([{ action: 'stopShipment', receiptId: 'c1', detail: { count: 1 } }]);
    expect(h.notifier.sent.find((m) => m.title === '고객 취소 자동 처리')!.body).toContain('출고중지완료');
  });

  it('자동 발주 첫 실패부터 바로 알림(예치금 부족 등)', async () => {
    h = await makeHarness({ live: true });
    const { vendorItemId } = await seedActiveListing(h);
    h.apiSource.failNext.set('placeOrder', 1);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('SOURCE_ERROR');
    expect(h.notifier.titles()).toContain('자동 발주 실패(자동 재시도 중)');
    await cycle();
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PURCHASED');
  });

  it('택배사: 별칭 우선(CJ → CJGLS), 모르는 택배사는 알림', async () => {
    h = await makeHarness({ live: true });
    const s = await h.ctx.settings.get();
    expect(resolveCourierCode(s.orders.courierAliases, 'CJ')).toBe('CJGLS');
    expect(resolveCourierCode(s.orders.courierAliases, '롯데글로벌로지스')).toBe('HYUNDAI');
    expect(resolveCourierCode(s.orders.courierAliases, 'HANJIN')).toBe('HANJIN');
    const { vendorItemId } = await seedActiveListing(h);
    const line = h.market.seedOrder({ vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await cycle();
    const o = await orderByBox(h, line.shipmentBoxId);
    h.apiSource.ship(o.source_order_id!, '999888777666', '알수없는택배');
    await pollFulfillment(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PURCHASED');
    expect(h.notifier.titles()).toContain('송장 자동 등록 실패');
  });
});

// ── 오너클랜 실제 스키마 규칙(2026-10-14 실서버 검증) ─────────────────────
describe('오너클랜 실서버 규칙', () => {
  const jsonRes = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
  const queries: string[] = [];
  const vars: any[] = [];
  let orderStatus = 'paid';
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.includes('/auth')) return new Response('jwt', { status: 200 });
    const body = JSON.parse(String(init?.body));
    const q: string = body.query;
    queries.push(q);
    vars.push(body.variables);
    if (q.includes('allItems')) return jsonRes({ data: { allItems: { edges: [
      { node: { key: 'A', name: '정리함', price: 9000, shippingFee: 3000, shippingType: 'inAdvance' } },
      { node: { key: 'B', name: '착불 정리함', price: 9000, shippingFee: 3000, shippingType: 'uponArrival' } },
    ] } } });
    if (q.includes('item(key')) return jsonRes({ data: { item: { key: 'A', name: '정리함', price: 9000, shippingFee: 3000, shippingType: 'inAdvance', status: 'available', images: [], openmarketSellable: true,
      options: [
        { optionAttributes: [{ name: '색상', value: '화이트' }], price: 8000, quantity: 50, status: 'soldout' },
        { optionAttributes: [{ name: '색상', value: '블랙' }], price: 9000, quantity: 20, status: 'available' },
      ] } } });
    if (q.includes('allOrders')) return jsonRes({ data: { allOrders: { edges: [] } } });
    if (q.includes('simulateCreateOrder')) return jsonRes({ data: { simulateCreateOrder: [{ itemAmounts: [{ itemKey: 'A', amount: 9000 }], shippingAmount: 3000, extraShippingFeeExists: false }] } });
    if (q.includes('createOrder')) {
      // 실서버: simulationResult 변수는 [CreateOrderSimulationResultInput!] 이어야 함
      if (!q.includes('[CreateOrderSimulationResultInput!]')) return jsonRes({ errors: [{ message: 'Variable "$sim" of type "[CreateOrderSimulationResultInput]" used in position expecting type "[CreateOrderSimulationResultInput!]".' }] });
      return jsonRes({ data: { createOrder: [{ key: 'OC9', status: 'paid' }] } });
    }
    if (q.includes('cancelOrder')) return jsonRes({ data: { cancelOrder: { key: body.variables.key, status: 'cancelled' } } });
    if (q.includes('order(key')) return jsonRes({ data: { order: { status: orderStatus, products: [{ trackingNumber: null }] } } });
    return jsonRes({ errors: [{ message: 'unknown' }] });
  }) as unknown as typeof fetch;
  const oc = new OwnerclanSource({ username: 'u', password: 'p', logger: log, fetchImpl, requestsPerSecond: 100 });

  it('착불 상품 제외, 품절 옵션은 기본 옵션에서 제외', async () => {
    expect((await oc.search('정리함')).map((x) => x.sourceItemId)).toEqual(['A']);
    const d = (await oc.getProduct('A'))!;
    expect(d.defaultOption).toBe('블랙'); // 화이트가 더 싸지만 품절
    expect(d.price).toBe(9000);
    expect(d.stock).toBe(20);
  });

  it('발주 요청이 실서버 변수 타입 규칙을 지킴(옵션 지정 포함)', async () => {
    const r = await oc.placeOrder({ idempotencyKey: 'cp-9', sourceItemId: 'A', option: '블랙', qty: 1, receiver: { name: '홍', phone: '0502', addr1: 'a', addr2: 'b', zip: '1' }, sender: { name: '우리상점', phone: '010-1' } });
    expect(r).toEqual({ sourceOrderId: 'OC9', cost: 9000, shippingCost: 3000, needsPayment: false });
    const v = vars[queries.findIndex((q) => q.includes('createOrder(input'))];
    expect(v.input.products[0].optionAttributes).toEqual(['블랙']);
    expect(v.input.sender).toEqual({ name: '우리상점', phoneNumber: '010-1' });
  });

  it('주문 상태 해석(결제대기·정상·취소), 취소 요청', async () => {
    orderStatus = 'placed';
    expect((await oc.getOrderInfo('OC9')).state).toBe('unpaid');
    orderStatus = 'preparing';
    expect((await oc.getOrderInfo('OC9')).state).toBe('ok');
    orderStatus = 'cancelled';
    expect((await oc.getOrderInfo('OC9')).state).toBe('cancelled');
    const c = await oc.cancelOrder('OC9', '고객 취소');
    expect(c.ok).toBe(true);
    expect(queries.at(-1)).toContain('requestOrderCancellation:true');
  });
});

describe('쿠팡 클라이언트', () => {
  it('정산 첫 페이지 token= 은 빈 값으로라도 보냄(실측: 없으면 400)', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ data: [], hasNext: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new CoupangClient({ baseUrl: 'https://x', vendorId: 'A1', accessKey: 'a', secretKey: 's', requestsPerSecond: 100, logger: log, fetchImpl });
    await c.request('GET', '/p', { query: { a: '1', token: null, skip: undefined, empty: '' } });
    expect(urls[0]).toBe('https://x/p?a=1&token=');
  });
});

describe('옵션 상품 표시', () => {
  it('기본 옵션 하나만 파는 상품은 상품명·상세에 옵션을 밝힘(긴 상품명이어도 옵션은 안 잘림)', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ listing: { multiVariant: false } }); // 옵션 하나만 파는 모드
    const { createDraftFromCandidate } = await import('../src/modules/listing/service.js');
    const { upsertSourceProduct } = await import('../src/modules/catalog.js');
    const d = h.apiSource.add({ sourceItemId: 'OPT1', title: '깔끔한 목욕 바구니 헬스장 사우나 수납정리함 파스텔 목욕용품 정리 바구니 대용량 다용도 손잡이형', price: 6000, defaultOption: '그린', options: [{ name: '그린', price: 6000, stock: 10 }, { name: '핑크', price: 6000, stock: 5 }] });
    const sp = await upsertSourceProduct(h.ctx, 'mockapi', d);
    const now = h.clock.now();
    const cand = await h.ctx.db.insertInto('candidates').values({ source_product_id: sp.id, keyword: '수납정리함', score: 0.9, passed: true, gates: JSON.stringify([]), signals: JSON.stringify({}), run_id: 't', status: 'new', created_at: now } as any).returning('id').executeTakeFirstOrThrow();
    const l = await createDraftFromCandidate(h.ctx, cand.id);
    expect(l.title.endsWith(' 그린')).toBe(true);
    expect(l.title.length).toBeLessThanOrEqual((await h.ctx.settings.get()).listing.maxTitleLength);
  });
});

describe('실전 준비 점검(golive.sh)', () => {
  it('막아야 할 항목(텔레그램·쿠팡 정보·오너클랜·이미지 주소)을 짚어주고, 다 갖추면 통과', async () => {
    const { goLiveReadiness } = await import('../src/modules/setup/golive.js');
    h = await makeHarness({ live: true });
    let r = await goLiveReadiness(h.ctx);
    expect(r.ok).toBe(false);
    const bad = r.items.filter((i) => !i.ok && i.critical).map((i) => i.name);
    expect(bad).toEqual(expect.arrayContaining(['텔레그램 알림', '쿠팡 판매자 정보(출고지·반품지 등)', '오너클랜 연결(자동 발주)']));
    await h.close();

    h = await makeHarness({ live: true, env: { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1', MEDIA_PUBLIC_BASE_URL: 'https://mac.ts.net' } });
    await h.ctx.settings.update({ listing: { convertImages: true }, coupang: { vendorUserId: 'wing', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588-0000', returnZipCode: '04524', returnAddress: '서울' } });
    const oc = Object.assign(h.apiSource, { findOrderByKey: async () => null });
    (h.ctx.sources as any).register(Object.assign(Object.create(Object.getPrototypeOf(oc)), oc, { id: 'ownerclan' }));
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => (urls.push(u), new Response('ok'))) as unknown as typeof fetch;
    r = await goLiveReadiness(h.ctx, { fetchImpl });
    expect(r.items.filter((i) => !i.ok && i.critical)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(urls).toEqual(['https://mac.ts.net/media/_ping']);
  });
});

describe('11번가 시장가: 같은 상품끼리 비교', () => {
  it('같은 상품이 있으면 그 최저가(비싸면 탈락), 없으면 키워드 중앙가는 참고만', async () => {
    const { similarProduct } = await import('../src/modules/selection/demandModel.js');
    const { productMarketReference } = await import('../src/modules/selection/scoring.js');
    expect(similarProduct('접이식 캠핑의자 경량 블랙', '캠핑의자 접이식 경량 체어 그린')).toBe(true);
    expect(similarProduct('접이식 캠핑의자 경량', '캠핑의자 커버 방수 원단')).toBe(false);
    const items = [
      { title: '미니 캠핑 스툴 의자 소형', price: 4500 }, // 다른 상품(작은 스툴)
      { title: '접이식 캠핑의자 경량 체어', price: 12900 },
      { title: '캠핑의자 접이식 경량 등받이', price: 13900 },
      { title: '릴렉스 캠핑의자 대형 체어', price: 39000 },
    ];
    const sig = { marketLowest: 4500, marketMedian: 13400, marketSource: '11번가' };
    const same = productMarketReference(sig, items, '접이식 캠핑의자 경량 블랙')!;
    expect(same).toMatchObject({ price: 12900, exact: true });
    const none = productMarketReference(sig, items, '캠핑 테이블 롤 테이블')!;
    expect(none).toMatchObject({ price: 13400, exact: false }); // 4,500원 스툴과 비교하지 않음
  });

  it('게이트: 같은 상품보다 비싸면 탈락, 키워드 중앙가보다 비싼 건 탈락시키지 않음(점수만)', async () => {
    h = await makeHarness({ live: true });
    const { evaluateGates } = await import('../src/modules/selection/scoring.js');
    const { targetPrice } = await import('../src/modules/pricing/pricing.js');
    const s = await h.ctx.settings.get();
    const d = h.apiSource.add({ sourceItemId: 'T1', title: '원목 캠핑 테이블 접이식', price: 9000, stock: 100 });
    const tp = targetPrice(s, { cost: d.price, shipping: d.shippingFee, categoryPath: d.categoryPath, inputVatDeductible: true });
    const comp = (ref: { price: number; source: string; exact: boolean }) => evaluateGates(s, d, tp, {}, { apiOrder: true, marketRef: ref }).find((g) => g.name === 'competitive')!;
    expect(comp({ price: tp.price - 1000, source: '11번가 같은 상품', exact: true })).toMatchObject({ hard: true, pass: false });
    expect(comp({ price: tp.price - 1000, source: '11번가 키워드 중앙가', exact: false })).toMatchObject({ hard: false, pass: false });
    expect(comp({ price: tp.price + 1000, source: '11번가 같은 상품', exact: true })).toMatchObject({ hard: true, pass: true });
  });
});
