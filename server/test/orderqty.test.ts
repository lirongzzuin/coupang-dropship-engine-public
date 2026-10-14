import { afterEach, describe, expect, it } from 'vitest';
import { DomeggookSource } from '../src/adapters/domeggook/source.js';
import { createLogger } from '../src/lib/logger.js';
import { createDraftFromCandidate, linkExistingListing, quoteSourceItem, validateListing } from '../src/modules/listing/service.js';
import { canOrderQty, describeOrderQty, orderQtyIssue, orderQtyRule } from '../src/modules/orderQty.js';
import { overrideAndProcess, pollNewOrders, processPending } from '../src/modules/orders/service.js';
import { runSelection } from '../src/modules/selection/service.js';
import { syncListings } from '../src/modules/sync/service.js';
import { makeHarness, orderByBox, seedActiveListing, type TestHarness } from './helpers.js';

let h: TestHarness;
afterEach(async () => h && (await h.close()));
const log = createLogger('silent');
const COUPANG = { vendorUserId: 'w', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588-0000', returnZipCode: '04524', returnAddress: '서울' };

describe('최소 구매수량·구매 단위 규칙', () => {
  it('1개씩 발주 가능 여부와 사유', () => {
    expect(orderQtyRule(undefined)).toEqual({ min: 1, unit: 1 }); // 오너클랜(필드 없음)
    expect(orderQtyIssue({})).toBeNull();
    expect(orderQtyIssue({ minOrderQty: 2 })).toBe('공급처 최소 구매수량 2개 — 1개씩 발주 불가');
    expect(orderQtyIssue({ orderUnit: 100 })).toBe('공급처 구매 단위 100개 — 1개씩 발주 불가');
    expect(orderQtyIssue({ minOrderQty: 2, orderUnit: 100 })).toContain('최소 구매수량 2개·100개 단위');
    expect(orderQtyIssue({ minOrderQty: 0, orderUnit: Number.NaN })).toBeNull(); // 이상한 값은 1로
    expect(canOrderQty({ minOrderQty: 2 }, 1)).toBe(false);
    expect(canOrderQty({ minOrderQty: 2 }, 2)).toBe(true);
    expect(canOrderQty({ orderUnit: 2 }, 3)).toBe(false);
    expect(canOrderQty({}, 3)).toBe(true);
    expect(describeOrderQty({ minOrderQty: 2, orderUnit: 10 })).toBe('최소 2개·10개 단위');
    expect(describeOrderQty({ orderUnit: 2 })).toBe('2개 단위');
  });

  it('도매꾹: 도매매(배송대행)는 구매 단위 supplyUnit, 도매꾹(도매)는 최소 domeMoq·단위 domeUnit (실측 값)', async () => {
    const view = (qty: Record<string, unknown>) => (async () => new Response(JSON.stringify({ domeggook: { basis: { title: 't', status: '판매중' }, price: { supply: '3030', dome: '3000' }, qty, deli: { pay: '선결제', supply: { fee: 3000 }, dome: { fee: 3000 } }, thumb: {}, desc: {}, seller: {}, category: {}, detail: {} } }), { status: 200 })) as unknown as typeof fetch;
    // 실제 바스켓(60000001): 도매매 1개 단위, 도매꾹 최소 2개
    const q = { inventory: '3600', domeMoq: '2', domeUnit: 1, supplyUnit: 1 };
    const supply = (await new DomeggookSource({ apiKey: 'K', market: 'supply', logger: log, fetchImpl: view(q) }).getProduct('60000001'))!;
    expect(supply).toMatchObject({ minOrderQty: 1, orderUnit: 1 });
    expect(orderQtyIssue(supply)).toBeNull();
    const dome = (await new DomeggookSource({ apiKey: 'K', market: 'dome', logger: log, fetchImpl: view(q) }).getProduct('60000001'))!;
    expect(orderQtyIssue(dome)).toBe('공급처 최소 구매수량 2개 — 1개씩 발주 불가');
    const hundred = (await new DomeggookSource({ apiKey: 'K', market: 'dome', logger: log, fetchImpl: view({ inventory: '9999', domeMoq: '1', domeUnit: 100, supplyUnit: 1 }) }).getProduct('1'))!;
    expect(orderQtyIssue(hundred)).toBe('공급처 구매 단위 100개 — 1개씩 발주 불가');
  });
});

describe('등록 경로마다 적용', () => {
  it('자동 선정: 최소 구매수량·구매 단위가 1이 아니면 탈락(자동 등록 안 함)', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ coupang: COUPANG, selection: { autoListPerRun: 5, maxPerKeyword: 5 } });
    h.marketData.volume.set('정리함', 20000);
    h.apiSource.add({ sourceItemId: 'OK', title: '스텐 수납 정리함', price: 16000 });
    h.apiSource.add({ sourceItemId: 'MOQ', title: '원목 서랍 정리함', price: 17000, minOrderQty: 2 });
    h.apiSource.add({ sourceItemId: 'UNIT', title: '플라스틱 수납 정리함', price: 15000, orderUnit: 10 });
    const r = await runSelection(h.ctx, { keywords: ['정리함'] });
    expect(r.autoListed).toBe(1);
    const cands = await h.ctx.db.selectFrom('candidates').innerJoin('source_products', 'source_products.id', 'candidates.source_product_id')
      .select(['source_products.source_item_id', 'candidates.passed', 'candidates.gates']).execute();
    const gate = (id: string) => (cands.find((c) => c.source_item_id === id)!.gates as Array<{ name: string; pass: boolean; detail: string }>).find((g) => g.name === 'moq')!;
    expect(gate('OK').pass).toBe(true);
    expect(gate('MOQ')).toMatchObject({ pass: false, detail: '공급처 최소 구매수량 2개 — 1개씩 발주 불가' });
    expect(gate('UNIT')).toMatchObject({ pass: false, detail: '공급처 구매 단위 10개 — 1개씩 발주 불가' });
  });

  it('후보 탭 직접 승인·초안 등록에서도 막음', async () => {
    h = await makeHarness({ live: true });
    const x = await seedActiveListing(h);
    h.apiSource.products.get(x.d.sourceItemId)!.minOrderQty = 3;
    const { upsertSourceProduct } = await import('../src/modules/catalog.js');
    await upsertSourceProduct(h.ctx, 'mockapi', h.apiSource.products.get(x.d.sourceItemId)!);
    await h.ctx.db.updateTable('listings').set({ status: 'stopped' }).where('id', '=', x.listing.id).execute();
    const cand = await h.ctx.db.insertInto('candidates').values({ source_product_id: x.listing.source_product_id, keyword: 'k', score: 0.5, signals: '{}', gates: '[]', passed: false, run_id: 'r', status: 'new', created_at: h.clock.now() }).returning('id').executeTakeFirstOrThrow();
    await expect(createDraftFromCandidate(h.ctx, cand.id, 'admin')).rejects.toThrow('공급처 최소 구매수량 3개');
    // 이미 만든 초안이 있어도 쿠팡 등록 전 검증에서 막음
    await h.ctx.db.updateTable('listings').set({ status: 'draft' }).where('id', '=', x.listing.id).execute();
    const l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', x.listing.id).executeTakeFirstOrThrow();
    expect(await validateListing(h.ctx, l)).toContain('공급처 최소 구매수량 3개 — 1개씩 발주 불가');
  });

  it('기존 쿠팡 상품 연결·견적: 연결은 막고 견적엔 사유 표시', async () => {
    h = await makeHarness({ live: true });
    h.apiSource.add({ sourceItemId: 'M2', title: '수납함', price: 15000, minOrderQty: 2 });
    const q = await quoteSourceItem(h.ctx, 'mockapi', 'M2');
    expect(q.orderQtyIssue).toBe('공급처 최소 구매수량 2개 — 1개씩 발주 불가');
    await expect(linkExistingListing(h.ctx, { vendorItemId: '123', salePrice: 30000, source: 'mockapi', sourceItemId: 'M2' }, 'admin')).rejects.toThrow('연결할 수 없는 공급처 상품');
    h.apiSource.add({ sourceItemId: 'M1', title: '수납함 B', price: 15000 });
    expect((await quoteSourceItem(h.ctx, 'mockapi', 'M1')).orderQtyIssue).toBeNull();
  });
});

describe('판매 중 감시·주문', () => {
  it('등록 뒤 공급처가 최소 구매수량을 올리면 판매중지, 다시 1개가 되면 재개', async () => {
    h = await makeHarness({ live: true });
    const x = await seedActiveListing(h);
    h.apiSource.products.get(x.d.sourceItemId)!.minOrderQty = 2;
    await syncListings(h.ctx);
    let l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', x.listing.id).executeTakeFirstOrThrow();
    expect(l.status).toBe('paused');
    expect(l.status_reason).toBe('공급처 판매 불가: 공급처 최소 구매수량 2개 — 1개씩 발주 불가');
    expect(h.market.items.get(x.vendorItemId)!.onSale).toBe(false);
    h.apiSource.products.get(x.d.sourceItemId)!.minOrderQty = 1;
    await syncListings(h.ctx);
    l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', x.listing.id).executeTakeFirstOrThrow();
    expect(l.status).toBe('active');
  });

  it('주문 시점에 살 수 없는 수량이면 자동 구매하지 않고 확인 필요 + 판매중지(강행하면 진행)', async () => {
    h = await makeHarness({ live: true });
    const x = await seedActiveListing(h);
    h.apiSource.products.get(x.d.sourceItemId)!.orderUnit = 2; // 동기화 전에 바뀜
    const line = h.market.seedOrder({ vendorItemId: x.vendorItemId, paidAmount: 30000, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    let o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('MANUAL_REVIEW');
    expect(o.status_reason).toBe('공급처 구매 수량 2개 단위 — 1개 발주 불가');
    expect(h.apiSource.orders.size).toBe(0);
    expect(h.notifier.titles()).toContain('공급처 최소 구매수량 때문에 발주 불가');
    expect((await h.ctx.db.selectFrom('listings').select('status').where('id', '=', x.listing.id).executeTakeFirstOrThrow()).status).toBe('paused');
    // 사람이 확인 후 강행(예: 2개 사서 1개 보냄)
    o = await overrideAndProcess(h.ctx, o.id, 'admin');
    expect(o.status).toBe('PURCHASED');
  });

  it('묶음 옵션(2개) 주문은 최소 2개 공급처에서도 발주 가능', async () => {
    const r = canOrderQty({ minOrderQty: 2 }, 1 * 2);
    expect(r).toBe(true);
  });
});
