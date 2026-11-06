import { afterEach, describe, expect, it } from 'vitest';
import { buildCoupangPayload } from '../src/modules/listing/payload.js';
import { listNameFixes, markNameFixed, refreshListingStatuses } from '../src/modules/listing/service.js';
import { limitRepeats, productNameFor } from '../src/modules/listing/text.js';
import { reconcileMarketState } from '../src/modules/monitor/service.js';
import { listedBefore, runSelection } from '../src/modules/selection/service.js';
import { syncListings } from '../src/modules/sync/service.js';
import { defaultSettings } from '../src/config/settings.js';
import { makeHarness, seedActiveListing, type TestHarness, logged } from './helpers.js';

let h: TestHarness;
afterEach(async () => h && (await h.close()));
const DAY = 24 * 60;
const COUPANG = { vendorUserId: 'w', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588-0000', returnZipCode: '04524', returnAddress: '서울 중구 세종대로 110', returnAddressDetail: '1층' };
const listingOf = (id: number) => h.ctx.db.selectFrom('listings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

/** 실제 쿠팡 상품(판매가 30,000 · 하한가 22,000) */
async function seedReal(opts: Parameters<typeof seedActiveListing>[1] = {}) {
  const x = await seedActiveListing(h, opts);
  await h.ctx.db.updateTable('listings').set({ dry_run: false }).where('id', '=', x.listing.id).execute();
  return x;
}

describe('Wing에서 삭제한 상품 → 자동 정리', () => {
  it('판매중·일시중지 상품을 Wing에서 삭제하면 판매종료(쿠팡에서 삭제됨), 같은 상품은 다시 등록 안 함', async () => {
    h = await makeHarness({ live: true });
    const a = await seedReal();
    const b = await seedReal();
    await h.ctx.db.updateTable('listings').set({ status: 'paused', status_reason: '공급처 품절' }).where('id', '=', b.listing.id).execute();
    const keep = await seedReal();
    h.market.deleteInWing(a.listing.seller_product_id!, [a.vendorItemId]);
    h.market.deleteInWing(b.listing.seller_product_id!, [b.vendorItemId]);
    const r = await reconcileMarketState(h.ctx);
    expect(r).toMatchObject({ deleted: 2, errors: 0 });
    for (const x of [a, b]) {
      const l = await listingOf(x.listing.id);
      expect(l.status).toBe('stopped');
      expect(l.status_reason).toContain('쿠팡에서 삭제됨');
      expect(await listedBefore(h.ctx, 'mockapi', x.d.sourceItemId)).toBe(true);
    }
    expect((await listingOf(keep.listing.id)).status).toBe('active');
    expect((await logged(h.ctx)).map((x) => x.title)).toContain('쿠팡에서 삭제한 상품 2개 정리');
    expect(h.notifier.titles()).not.toContain('쿠팡 판매상태 조회 실패'); // 삭제는 조회 실패가 아님
    // 다음 동기화가 되살리지 않음
    await syncListings(h.ctx);
    expect((await listingOf(a.listing.id)).status).toBe('stopped');
  });

  it('묶음 옵션 하나만 삭제(상품은 있음)면 정리하지 않음', async () => {
    h = await makeHarness({ live: true });
    const a = await seedReal();
    await h.ctx.db.insertInto('listing_items').values([
      { listing_id: a.listing.id, unit_qty: 1, item_name: 'x 1개', vendor_item_id: a.vendorItemId, sale_price: 30000, floor_price: 22000, created_at: h.clock.now() },
      { listing_id: a.listing.id, unit_qty: 2, item_name: 'x 2개', vendor_item_id: 'VI-B2', sale_price: 55000, floor_price: 40000, created_at: h.clock.now() },
    ]).execute();
    h.market.items.set('VI-B2', { price: 55000, qty: 10, onSale: true });
    h.market.deletedInWing.add('VI-B2'); // 옵션만 삭제
    const r = await reconcileMarketState(h.ctx);
    expect(r.deleted ?? 0).toBe(0);
    expect((await listingOf(a.listing.id)).status).toBe('active');
  });

  it('상품 조회가 일시 오류면 정리를 미루고 다음 실행에서 정리', async () => {
    h = await makeHarness({ live: true });
    const a = await seedReal();
    h.market.deleteInWing(a.listing.seller_product_id!, [a.vendorItemId]);
    h.market.failNext.set('getProductStatus', 1);
    expect((await reconcileMarketState(h.ctx)).deleted ?? 0).toBe(0);
    expect((await listingOf(a.listing.id)).status).toBe('active');
    expect((await reconcileMarketState(h.ctx)).deleted).toBe(1);
    expect((await listingOf(a.listing.id)).status).toBe('stopped');
  });

  it('심사 중 상품을 Wing에서 삭제해도 판매종료(반려로 남겨 재등록하지 않음)', async () => {
    h = await makeHarness({ live: true });
    const a = await seedReal();
    await h.ctx.db.updateTable('listings').set({ status: 'pending_approval' }).where('id', '=', a.listing.id).execute();
    h.market.deleteInWing(a.listing.seller_product_id!, []);
    await refreshListingStatuses(h.ctx);
    const l = await listingOf(a.listing.id);
    expect(l.status).toBe('stopped');
    expect(l.status_reason).toContain('쿠팡에서 삭제됨');
  });
});

describe('쿠팡(Wing)에서 바꾼 가격 반영', () => {
  it('같은 다른 가격이 두 번 연속 보이면 반영(한 번은 반영 지연일 수 있음)', async () => {
    h = await makeHarness({ live: true });
    const { listing, vendorItemId } = await seedReal();
    h.market.items.get(vendorItemId)!.price = 28000;
    await reconcileMarketState(h.ctx);
    expect((await listingOf(listing.id)).sale_price).toBe(30000);
    h.clock.advanceMinutes(60);
    expect((await reconcileMarketState(h.ctx)).priceAdopted).toBe(1);
    const l = await listingOf(listing.id);
    expect(l.sale_price).toBe(28000);
    expect(l.status).toBe('active');
    expect((await logged(h.ctx)).map((x) => x.title)).toContain('쿠팡(Wing)에서 바뀐 가격 1개 반영');
  });

  it('최근 3시간 안에 우리가 바꾼 가격은 반영 지연으로 보고 건너뜀', async () => {
    h = await makeHarness({ live: true });
    const { listing, vendorItemId } = await seedReal();
    await h.ctx.db.updateTable('listings').set({ price_set_at: h.clock.now() }).where('id', '=', listing.id).execute();
    h.market.items.get(vendorItemId)!.price = 28000;
    await reconcileMarketState(h.ctx);
    h.clock.advanceMinutes(60);
    await reconcileMarketState(h.ctx);
    expect((await listingOf(listing.id)).sale_price).toBe(30000);
  });

  it('손실 가격이면 판매중지 → 동기화가 손실 없는 가격으로 올려 재개', async () => {
    h = await makeHarness({ live: true });
    const { listing, vendorItemId } = await seedReal();
    h.market.items.get(vendorItemId)!.price = 15000;
    await reconcileMarketState(h.ctx);
    h.clock.advanceMinutes(60);
    await reconcileMarketState(h.ctx);
    let l = await listingOf(listing.id);
    expect(l.status).toBe('paused');
    expect(l.status_reason).toContain('마진 역전');
    expect(h.market.items.get(vendorItemId)!.onSale).toBe(false);
    await syncListings(h.ctx);
    l = await listingOf(listing.id);
    expect(l.status).toBe('active'); // 1회 +50% 가드 → 손실 없는 22,500원, 나머지는 다음 날
    expect(l.sale_price).toBe(22500);
    h.clock.advanceMinutes(DAY);
    await syncListings(h.ctx);
    l = await listingOf(listing.id);
    expect(l.sale_price).toBeGreaterThanOrEqual(l.floor_price);
  });

  it('설정으로 끌 수 있음(monitor.adoptMarketPrice)', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ monitor: { adoptMarketPrice: false } });
    const { listing, vendorItemId } = await seedReal();
    h.market.items.get(vendorItemId)!.price = 28000;
    await reconcileMarketState(h.ctx);
    h.clock.advanceMinutes(60);
    await reconcileMarketState(h.ctx);
    expect((await listingOf(listing.id)).sale_price).toBe(30000);
  });
});

describe('상품명에서 옵션과 중복된 단어 제거', () => {
  it('옵션 값(색상·사이즈·수량)을 상품명에서 빼고, 같은 단어는 2번까지만', () => {
    expect(productNameFor('접이식 수납 정리함 블랙 1개', ['블랙', '1개'])).toBe('접이식 수납 정리함');
    expect(productNameFor('리빙박스 30 x 40 cm 화이트', ['30x40cm', '화이트'])).toBe('리빙박스');
    expect(productNameFor('정리함 대형 / 빨강', ['대형 / 빨강'])).toBe('정리함');
    expect(productNameFor('물티슈 10개입 캡형', ['1개'])).toBe('물티슈 10개입 캡형'); // 다른 단어의 일부는 그대로
    expect(productNameFor('블랙박스 거치대', ['블랙'])).toBe('블랙박스 거치대');
    expect(productNameFor('수납 수납 수납 바구니', [])).toBe('수납 수납 바구니');
    expect(productNameFor('블랙 1개', ['블랙', '1개'])).toBe('블랙 1개'); // 너무 짧아지면 원래 이름
    expect(limitRepeats('a A a b', 2)).toBe('a A b');
  });

  it('쿠팡 등록 요청: 노출상품명엔 옵션 단어가 없고 구매옵션엔 그대로', () => {
    const s = defaultSettings();
    const p = buildCoupangPayload(s, {
      vendorId: 'A0', title: '스텐 수납 정리함 블랙 44리터', categoryCode: '1',
      options: [{ units: 1, salePrice: 19900, itemName: 'x 1개' }, { units: 2, salePrice: 36900, itemName: 'x 2개' }],
      stock: 50, images: ['https://i/1.jpg'], detailHtml: '<p/>', tags: [],
      meta: { code: '1', notices: [], requiredAttributes: ['색상', '사이즈', '수량'], attributeNames: ['색상', '사이즈', '수량'] },
      detail: null, sourceProductId: 1, now: new Date('2026-10-14T00:00:00Z'),
    }) as { displayProductName: string; sellerProductName: string; items: Array<{ attributes: Array<{ attributeTypeName: string; attributeValueName: string }> }> };
    expect(p.displayProductName).toBe('스텐 수납 정리함');
    expect(p.sellerProductName).toBe('스텐 수납 정리함');
    expect(p.items[0]!.attributes).toEqual(expect.arrayContaining([
      { attributeTypeName: '색상', attributeValueName: '블랙' },
      { attributeTypeName: '사이즈', attributeValueName: '44리터' },
      { attributeTypeName: '수량', attributeValueName: '1개' },
    ]));
    expect(p.items[1]!.attributes).toEqual(expect.arrayContaining([{ attributeTypeName: '수량', attributeValueName: '2개' }]));
  });

  it('자동 등록: 쿠팡에 보낸 노출상품명과 관리 화면 상품명이 같고 옵션 단어가 없음', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ coupang: COUPANG });
    h.apiSource.add({ sourceItemId: 'N1', title: '접이식 수납 정리함 1개', price: 15000, stock: 200 });
    h.marketData.lowest.set('수납 정리함', 35000);
    h.marketData.volume.set('수납 정리함', 20000);
    const r = await runSelection(h.ctx, { keywords: ['수납 정리함'] });
    expect(r.autoListed).toBe(1);
    const l = await h.ctx.db.selectFrom('listings').selectAll().where('status', '=', 'pending_approval').executeTakeFirstOrThrow();
    const sent = h.market.products.get(l.seller_product_id!)!.payload;
    expect(sent.displayProductName).toBe('접이식 수납 정리함');
    expect(l.title).toBe('접이식 수납 정리함');
    expect(sent.items[0].attributes).toEqual(expect.arrayContaining([{ attributeTypeName: '수량', attributeValueName: '1개' }]));
  });

  it('이전 버전으로 올린 상품: 고칠 이름 제안 → [수정함]이면 목록에서 빠지고 상품명 반영', async () => {
    h = await makeHarness({ live: true });
    const a = await seedReal();
    const ok = await seedReal();
    const payload = (name: string) => JSON.stringify({ displayProductName: name, sellerProductName: name, items: [{ attributes: [{ attributeTypeName: '색상', attributeValueName: '블랙' }, { attributeTypeName: '수량', attributeValueName: '1개' }] }] });
    await h.ctx.db.updateTable('listings').set({ payload: payload('수납 정리함 블랙 1개') }).where('id', '=', a.listing.id).execute();
    await h.ctx.db.updateTable('listings').set({ payload: payload('수납 정리함') }).where('id', '=', ok.listing.id).execute();
    const fixes = await listNameFixes(h.ctx);
    expect(fixes).toEqual([{ id: a.listing.id, status: 'active', sellerProductId: a.listing.seller_product_id, current: '수납 정리함 블랙 1개', suggested: '수납 정리함' }]);
    await markNameFixed(h.ctx, a.listing.id, 'admin');
    expect(await listNameFixes(h.ctx)).toEqual([]);
    expect((await listingOf(a.listing.id)).title).toBe('수납 정리함');
    await expect(markNameFixed(h.ctx, ok.listing.id, 'admin')).rejects.toThrow(/고칠 상품명이 없는/);
  });
});

describe('아이템위너 입력 제거 후 호환', () => {
  it('007 컬럼은 남아 있어도(롤백 대비) 사용하지 않음 — 위너 입력 API 없음', async () => {
    h = await makeHarness({ live: true });
    const { listing } = await seedReal();
    const l = (await listingOf(listing.id)) as Record<string, unknown>;
    expect(l.winner_status).toBeNull();
    const { JOBS } = await import('../src/jobs/scheduler.js');
    expect(JOBS.length).toBeGreaterThan(0);
    await expect(import('../src/modules/listing/winner.js' as string)).rejects.toThrow();
  });
});
