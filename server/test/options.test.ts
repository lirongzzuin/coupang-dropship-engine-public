import { afterEach, describe, expect, it } from 'vitest';
import { DomeggookSource, parseDomeggookOptions } from '../src/adapters/domeggook/source.js';
import { createLogger } from '../src/lib/logger.js';
import { AttributeError, buildAttributes, buildCoupangPayload } from '../src/modules/listing/payload.js';
import { relistWithOption } from '../src/modules/listing/service.js';
import { colorFor, findColor, findSize, sizeFor, variantOf } from '../src/modules/listing/variant.js';
import { pollNewOrders, processPending } from '../src/modules/orders/service.js';
import { syncListings } from '../src/modules/sync/service.js';
import { defaultSettings } from '../src/config/settings.js';
import type { CategoryMeta } from '../src/ports/market.js';
import type { SourceProductDetail } from '../src/ports/source.js';
import { makeHarness, orderByBox, seedActiveListing, type TestHarness } from './helpers.js';

let h: TestHarness;
afterEach(async () => h && (await h.close()));
const log = createLogger('silent');
const COUPANG = { vendorUserId: 'w', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588-0000', returnZipCode: '04524', returnAddress: '서울 중구 세종대로 110', returnAddressDetail: '1층' };
/** 실제 쿠팡 카테고리(80719 수납바구니) 필수 구매옵션 */
const META: CategoryMeta = {
  code: '80719', notices: [], requiredAttributes: ['색상', '사이즈', '수량'], attributeNames: ['색상', '사이즈', '수량'],
  requiredAttributeSpecs: [{ name: '색상', dataType: 'STRING' }, { name: '사이즈', dataType: 'STRING' }, { name: '수량', dataType: 'NUMBER', basicUnit: '개', usableUnits: ['개'] }],
};

// 실제 도매꾹 응답(2026-10-14 조회): 수납 바스켓 60000001 — 옵션 축 '옵션' 하나에 사이즈·색상이 섞임, 4호는 +680원
const BASKET = JSON.stringify({
  type: 'combination', optSort: 'DA',
  set: [{ opts: ['심플바스켓 (3호 화이트)', '심플바스켓 (4호 화이트)', '심플바스켓 (3호 차콜)', '심플바스켓 (4호 차콜)'], domPrice: ['0', '680', '0', '680'], name: '옵션' }],
  data: {
    '00': { name: '심플바스켓 (3호 화이트)', dom: '1', domPrice: '0', sup: '1', supPrice: '0', qty: '900', hid: '0' },
    '01': { name: '심플바스켓 (4호 화이트)', dom: '1', domPrice: '680', sup: '1', supPrice: '680', qty: '900', hid: '0' },
    '02': { name: '심플바스켓 (3호 차콜)', dom: '1', domPrice: '0', sup: '1', supPrice: '0', qty: '900', hid: '0' },
    '03': { name: '심플바스켓 (4호 차콜)', dom: '1', domPrice: '680', sup: '1', supPrice: '680', qty: '900', hid: '0' },
  },
});
// 실제 응답: 색상×사이즈 두 축(키 "00_01"), 숨김(hid=2)·재고 0
const TEE = JSON.stringify({
  type: 'combination',
  set: [{ name: '색상', opts: ['블랙', '그레이'] }, { name: '사이즈', opts: ['M', 'L'] }],
  data: {
    '00_00': { name: '블랙/M', sup: '1', supPrice: '0', qty: '0', hid: '0' },
    '00_01': { name: '블랙/L', sup: '1', supPrice: '0', qty: '9999', hid: '0' },
    '01_00': { name: '그레이/M', sup: '1', supPrice: '0', qty: '0', hid: '2' },
    '01_01': { name: '그레이/L', sup: '1', supPrice: '500', qty: '9999', hid: '0' },
  },
});

describe('도매꾹 주문옵션(selectOpt) 해석', () => {
  it('한 축 조합형: 옵션별 가격(기본가+추가금)·재고, 축 이름·값', () => {
    const r = parseDomeggookOptions(BASKET, 'supply', 3030);
    expect(r.issue).toBeUndefined();
    expect(r.options.map((o) => [o.name, o.price, o.stock])).toEqual([
      ['심플바스켓 (3호 화이트)', 3030, 900], ['심플바스켓 (4호 화이트)', 3710, 900], ['심플바스켓 (3호 차콜)', 3030, 900], ['심플바스켓 (4호 차콜)', 3710, 900],
    ]);
    expect(r.options[0]!.attrs).toEqual([{ name: '옵션', value: '심플바스켓 (3호 화이트)' }]);
  });

  it('두 축 조합형: 축별 값, 숨김·재고 0 은 품절, 도매꾹(dome) 시장은 domPrice', () => {
    const r = parseDomeggookOptions(TEE, 'supply', 14900);
    expect(r.options.find((o) => o.name === '블랙/L')).toMatchObject({ price: 14900, stock: 9999, attrs: [{ name: '색상', value: '블랙' }, { name: '사이즈', value: 'L' }] });
    expect(r.options.find((o) => o.name === '그레이/M')!.stock).toBe(0);
    expect(r.options.find((o) => o.name === '그레이/L')!.price).toBe(15400);
    const notSold = parseDomeggookOptions(JSON.stringify({ type: 'combination', set: [{ name: '옵션', opts: ['A'] }], data: { '00': { name: 'A', sup: '0', qty: '10', hid: '0' } } }), 'supply', 1000);
    expect(notSold.options[0]!.stock).toBe(0); // 도매매에서 안 파는 옵션
  });

  it('독립형: 축 하나면 지원, 여러 개면 등록 불가 사유', () => {
    const one = parseDomeggookOptions(JSON.stringify({ type: 'independent', set: [{ name: '제품선택', opts: ['230', '240'] }], data: { '00_00': { name: '제품선택/230', qty: '5', hid: '0', sup: '1' }, '00_01': { name: '제품선택/240', qty: '0', hid: '0', sup: '1' } } }), 'supply', 11200);
    expect(one.options).toEqual([{ name: '230', price: 11200, stock: 5, attrs: [{ name: '제품선택', value: '230' }] }, { name: '240', price: 11200, stock: 0, attrs: [{ name: '제품선택', value: '240' }] }]);
    const two = parseDomeggookOptions(JSON.stringify({ type: 'independent', set: [{ name: '색상', opts: ['a'] }, { name: '추가', opts: ['b'] }], data: { '00_00': { name: '색상/a' } } }), 'supply', 1);
    expect(two.issue).toContain('독립형');
    expect(parseDomeggookOptions(undefined, 'supply', 1)).toEqual({ options: [] });
    expect(parseDomeggookOptions('{bad', 'supply', 1).issue).toBeTruthy();
  });

  it('상세 조회: 가장 싼 재고 옵션을 판매 옵션으로, 고정 옵션 품절이면 다른 옵션으로 바꾸지 않음', async () => {
    let selectOpt = BASKET;
    const fetchImpl = (async () => new Response(JSON.stringify({ domeggook: {
      basis: { title: '수납 바스켓 주방리빙박스', status: '판매중' }, price: { supply: '3030' }, qty: { inventory: '3600', supplyUnit: 1 },
      deli: { pay: '선결제', supply: { fee: 3000 } }, thumb: {}, desc: { license: { usable: true } }, seller: {}, category: {}, detail: {}, selectOpt,
    } }), { status: 200 })) as unknown as typeof fetch;
    const dg = new DomeggookSource({ apiKey: 'K', market: 'supply', logger: log, fetchImpl });
    expect(await dg.getProduct('60000001')).toMatchObject({ status: 'active', defaultOption: '심플바스켓 (3호 화이트)', price: 3030, stock: 900 });
    expect(await dg.getProduct('60000001', { option: '심플바스켓 (4호 차콜)' })).toMatchObject({ defaultOption: '심플바스켓 (4호 차콜)', price: 3710 });
    selectOpt = BASKET.replace('"qty":"900","hid":"0"}', '"qty":"0","hid":"0"}'); // 3호 화이트 품절
    expect(await dg.getProduct('60000001', { option: '심플바스켓 (3호 화이트)' })).toMatchObject({ status: 'soldout', stock: 0, unavailableReason: '옵션(심플바스켓 (3호 화이트)) 품절' });
    expect(await dg.getProduct('60000001', { option: '심플바스켓 (5호)' })).toMatchObject({ status: 'ended', unavailableReason: '판매 옵션(심플바스켓 (5호))이 공급처에서 없어짐' });
    selectOpt = '';
    const single = (await dg.getProduct('1'))!;
    expect(single.options).toBeUndefined();
    expect(single.defaultOption).toBeUndefined();
  });
});

describe('구매옵션 값(색상·사이즈) 찾기', () => {
  it('텍스트에서 색상·사이즈(다른 단어의 일부는 제외)', () => {
    expect(findColor('심플바스켓 (3호 화이트)')).toBe('화이트');
    expect(findColor('소품 정리함 크림옐로우')).toBe('크림옐로우');
    expect(findColor('블랙박스 거치대')).toBeNull();
    expect(findSize('심플바스켓 (3호 화이트)')).toBe('3호');
    expect(findSize('높은 중형 바구니')).toBe('중형');
    expect(findSize('반팔티 2XL 블랙')).toBe('2XL');
    expect(findSize('리빙박스 30 x 40 cm')).toBe('30x40cm');
    expect(findSize('LED 무드등')).toBeNull();
    expect(findSize('대형마트 장바구니')).toBeNull();
  });

  it('바스켓(도매꾹): 옵션 이름에서 3호·화이트, 상품명엔 없어도', () => {
    const d = { title: 't', options: parseDomeggookOptions(BASKET, 'supply', 3030).options, defaultOption: '심플바스켓 (3호 화이트)' } as SourceProductDetail;
    const v = variantOf(d);
    expect(v).toMatchObject({ multi: true, colorVaries: true, sizeVaries: true });
    expect(colorFor(v, '수납 바스켓 주방리빙박스')).toBe('화이트');
    expect(sizeFor(v, '수납 바스켓 주방리빙박스')).toBe('3호');
    expect(buildAttributes(META, '수납 바스켓 주방리빙박스', 1, d)).toEqual([
      { attributeTypeName: '색상', attributeValueName: '화이트' }, { attributeTypeName: '사이즈', attributeValueName: '3호' }, { attributeTypeName: '수량', attributeValueName: '1개' },
    ]);
  });

  it('오너클랜: 옵션 축(사이즈=높은 중형, 색상=그레이)을 그대로 사용', () => {
    const d = { title: 't', options: [
      { name: '그레이 / 높은 중형', price: 3870, stock: 10, attrs: [{ name: '색상', value: '그레이' }, { name: '사이즈', value: '높은 중형' }] },
      { name: '화이트 / 낮은 대형', price: 4440, stock: 10, attrs: [{ name: '색상', value: '화이트' }, { name: '사이즈', value: '낮은 대형' }] },
    ], defaultOption: '그레이 / 높은 중형' } as SourceProductDetail;
    expect(buildAttributes(META, '플라스틱 손잡이 수납 바구니', 2, d)).toEqual([
      { attributeTypeName: '색상', attributeValueName: '그레이' }, { attributeTypeName: '사이즈', attributeValueName: '높은 중형' }, { attributeTypeName: '수량', attributeValueName: '2개' },
    ]);
  });

  it('오너클랜 실제 사례: 색상 축 "화이트 50p" → 화이트, 고유 색상명(1번 색)은 그대로', () => {
    const d = { title: 't', options: [{ name: '화이트 50p', price: 1, stock: 1, attrs: [{ name: '색상', value: '화이트 50p' }] }, { name: '레드 50p', price: 1, stock: 1, attrs: [{ name: '색상', value: '레드 50p' }] }], defaultOption: '화이트 50p' } as SourceProductDetail;
    expect(buildAttributes(META, '아크릴 코너선반', 1, d)[0]).toEqual({ attributeTypeName: '색상', attributeValueName: '화이트' });
    const own = { title: 't', options: [{ name: '1번', price: 1, stock: 1, attrs: [{ name: '색상', value: '1번' }] }, { name: '2번', price: 1, stock: 1, attrs: [{ name: '색상', value: '2번' }] }], defaultOption: '1번' } as SourceProductDetail;
    expect(buildAttributes(META, '머리끈', 1, own)[0]!.attributeValueName).toBe('1번');
  });

  it('옵션마다 색상이 다른데 판매 옵션의 색상을 못 찾으면 등록하지 않음(멀티로 올리지 않음)', () => {
    const d = { title: 't', options: [{ name: '블랙 소형', price: 5000, stock: 9 }, { name: '화이트 소형', price: 5000, stock: 9 }, { name: '대형', price: 4000, stock: 9 }], defaultOption: '대형' } as SourceProductDetail;
    expect(() => buildAttributes(META, '정리함', 1, d)).toThrow(/색상을 찾지 못함/);
    // 상품명에 다른 색이 있어도 옵션마다 색이 다르면 상품명 색상은 믿지 않음
    expect(() => buildAttributes(META, '정리함 블랙', 1, d)).toThrow(AttributeError);
  });

  it('단일 상품: 상품명·고시정보에서, 그래도 없으면 멀티·FREE', () => {
    expect(buildAttributes(META, '수납함 네이비 대형', 1, { title: 't', options: [] } as unknown as SourceProductDetail).slice(0, 2).map((a) => a.attributeValueName)).toEqual(['네이비', '대형']);
    const withNotice = { title: 't', notice: { items: [{ name: '색상', value: '내추럴 우드' }, { name: '크기', value: '가로 30 x 세로 20cm' }] } } as unknown as SourceProductDetail;
    expect(buildAttributes(META, '원목 트레이', 1, withNotice).slice(0, 2).map((a) => a.attributeValueName)).toEqual(['내추럴 우드', '가로 30 x 세로 20cm']);
    const meaningless = { title: 't', notice: { items: [{ name: '색상', value: '상세페이지 참조' }] } } as unknown as SourceProductDetail;
    expect(buildAttributes(META, '원목 트레이', 1, meaningless).slice(0, 2).map((a) => a.attributeValueName)).toEqual(['멀티', 'FREE']);
  });

  it('일반 축(제품선택)의 숫자 값은 사이즈(실제 도매꾹 슬리퍼 230~280) — FREE 로 올리지 않음', () => {
    const opts = parseDomeggookOptions(JSON.stringify({ type: 'independent', set: [{ name: '제품선택', opts: ['230', '240', '250'] }], data: {
      '00_00': { name: '제품선택/230', qty: '5', hid: '0', sup: '1' }, '00_01': { name: '제품선택/240', qty: '5', hid: '0', sup: '1' }, '00_02': { name: '제품선택/250', qty: '5', hid: '0', sup: '1' },
    } }), 'supply', 11200).options;
    const d = { title: 't', options: opts, defaultOption: '240' } as SourceProductDetail;
    expect(variantOf(d).sizeVaries).toBe(true);
    expect(buildAttributes(META, '꼬모슬리퍼 (그린)', 1, d).slice(0, 2).map((a) => a.attributeValueName)).toEqual(['그린', '240']);
    // 일반 축 값이 숫자가 아니면 사이즈로 보지 않음
    expect(sizeFor(variantOf({ title: 't', options: [{ name: '기본형', price: 1, stock: 1, attrs: [{ name: '옵션', value: '기본형' }] }] } as SourceProductDetail), '컵')).toBeNull();
  });

  it('옵션 해석 불가(도매꾹 독립형 여러 축)면 등록하지 않음', () => {
    expect(() => buildAttributes(META, '슬리퍼', 1, { title: 't', optionIssue: '도매꾹 독립형 옵션이 여러 개' } as SourceProductDetail)).toThrow(/독립형/);
  });

  it('쿠팡 등록 요청: 구매옵션은 옵션 값, 노출상품명엔 옵션 단어 없음', () => {
    const d = { title: 't', options: parseDomeggookOptions(BASKET, 'supply', 3030).options, defaultOption: '심플바스켓 (3호 화이트)' } as SourceProductDetail;
    const p = buildCoupangPayload(defaultSettings(), {
      vendorId: 'A0', title: '수납 바스켓 주방리빙박스 심플바스켓 3호 화이트', categoryCode: '80719',
      options: [{ units: 1, salePrice: 11900, itemName: 'x 1개' }], stock: 900, images: ['https://i/1.jpg'], detailHtml: '<p/>', tags: [],
      meta: META, detail: d, sourceProductId: 1, now: new Date('2026-10-14T00:00:00Z'),
    }) as { displayProductName: string; items: Array<{ attributes: unknown[] }> };
    expect(p.displayProductName).toBe('수납 바스켓 주방리빙박스 심플바스켓');
    expect(p.items[0]!.attributes).toEqual(expect.arrayContaining([{ attributeTypeName: '색상', attributeValueName: '화이트' }, { attributeTypeName: '사이즈', attributeValueName: '3호' }]));
  });
});

describe('옵션 없이 올라간 기존 상품 보호 + 옵션 지정해 다시 등록', () => {
  /** 옵션 4개(바스켓) 공급처 상품을 옵션 지정 없이 올린 실제 쿠팡 상품(이전 버전) */
  async function seedUnset() {
    const x = await seedActiveListing(h, { price: 3030, salePrice: 11900 });
    const p = h.apiSource.products.get(x.d.sourceItemId)!;
    p.title = '수납 바스켓 주방리빙박스';
    p.options = parseDomeggookOptions(BASKET, 'supply', 3030).options;
    const cand = await h.ctx.db.insertInto('candidates').values({ source_product_id: x.listing.source_product_id, keyword: '수납 바스켓', score: 0.5, signals: '{}', gates: '[]', passed: true, run_id: 'r0', status: 'listed', created_at: h.clock.now() }).returning('id').executeTakeFirstOrThrow();
    await h.ctx.db.updateTable('listings').set({ dry_run: false, candidate_id: cand.id, source_option: null }).where('id', '=', x.listing.id).execute();
    h.market.getCategoryMeta = async () => META;
    return x;
  }

  it('동기화가 옵션 미지정 상품을 판매중지하고 알림(자동 재개 안 함)', async () => {
    h = await makeHarness({ live: true });
    const x = await seedUnset();
    await syncListings(h.ctx);
    const l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', x.listing.id).executeTakeFirstOrThrow();
    expect(l.status).toBe('paused');
    expect(l.status_reason).toContain('옵션 미지정');
    expect(h.market.items.get(x.vendorItemId)!.onSale).toBe(false);
    expect(h.notifier.titles()).toContain('옵션이 정해지지 않은 상품 1개 판매중지');
    await syncListings(h.ctx);
    expect((await h.ctx.db.selectFrom('listings').select('status').where('id', '=', x.listing.id).executeTakeFirstOrThrow()).status).toBe('paused');
  });

  it('[옵션 지정해 다시 등록]: 옵션(3호 화이트)을 정해 정확한 구매옵션으로 새 등록, 이전 상품은 판매종료 → 주문은 그 옵션으로 발주', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ coupang: COUPANG });
    const x = await seedUnset();
    await syncListings(h.ctx);
    const fresh = await relistWithOption(h.ctx, x.listing.id, 'admin');
    expect(fresh.status).toBe('pending_approval');
    expect(fresh.source_option).toBe('심플바스켓 (3호 화이트)');
    const old = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', x.listing.id).executeTakeFirstOrThrow();
    expect(old.status).toBe('stopped');
    const sent = h.market.products.get(fresh.seller_product_id!)!.payload;
    expect(sent.items[0].attributes).toEqual(expect.arrayContaining([{ attributeTypeName: '색상', attributeValueName: '화이트' }, { attributeTypeName: '사이즈', attributeValueName: '3호' }]));
    expect(sent.displayProductName).not.toMatch(/3호|화이트/);
    // 승인 → 주문 → 그 옵션으로 발주
    const { refreshListingStatuses } = await import('../src/modules/listing/service.js');
    h.market.autoApprove = true;
    await refreshListingStatuses(h.ctx);
    const active = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', fresh.id).executeTakeFirstOrThrow();
    expect(active.status).toBe('active');
    const vi = (await h.ctx.db.selectFrom('listing_items').select('vendor_item_id').where('listing_id', '=', fresh.id).where('unit_qty', '=', 1).executeTakeFirstOrThrow()).vendor_item_id!;
    const line = h.market.seedOrder({ vendorItemId: vi, paidAmount: active.sale_price, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PURCHASED');
    expect([...h.apiSource.orders.values()][0]!.req.option).toBe('심플바스켓 (3호 화이트)');
  });

  it('다시 등록이 실패하면 이전 상품을 판매중지 상태로 되돌림', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ coupang: COUPANG });
    const x = await seedUnset();
    await syncListings(h.ctx);
    h.market.failNext.set('createProduct', 1);
    await expect(relistWithOption(h.ctx, x.listing.id, 'admin')).rejects.toThrow(/다시 등록 실패/);
    const old = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', x.listing.id).executeTakeFirstOrThrow();
    expect(old.status).toBe('paused');
    expect(old.status_reason).toContain('옵션 미지정');
  });

  it('직접 연결한 상품·종료 상품은 다시 등록 불가', async () => {
    h = await makeHarness({ live: true });
    const x = await seedActiveListing(h);
    await expect(relistWithOption(h.ctx, x.listing.id, 'admin')).rejects.toThrow(/직접 연결/);
  });
});
