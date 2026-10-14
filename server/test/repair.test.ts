import { afterEach, describe, expect, it } from 'vitest';
import { parseDomeggookOptions } from '../src/adapters/domeggook/source.js';
import { CoupangMarket } from '../src/adapters/coupang/market.js';
import { repairListings } from '../src/modules/monitor/repair.js';
import { syncListings } from '../src/modules/sync/service.js';
import type { CategoryMeta } from '../src/ports/market.js';
import { makeHarness, seedActiveListing, type TestHarness } from './helpers.js';

let h: TestHarness;
afterEach(async () => h && (await h.close()));
const HOUR = 60;
const META: CategoryMeta = {
  code: '80719', notices: [], requiredAttributes: ['색상', '사이즈', '수량'], attributeNames: ['색상', '사이즈', '수량'],
  requiredAttributeSpecs: [{ name: '색상', dataType: 'STRING' }, { name: '사이즈', dataType: 'STRING' }, { name: '수량', dataType: 'NUMBER', basicUnit: '개', usableUnits: ['개'] }],
};
const BASKET = JSON.stringify({
  type: 'combination', set: [{ name: '옵션', opts: [] }],
  data: {
    '00': { name: '심플바스켓 (3호 화이트)', sup: '1', supPrice: '0', qty: '900', hid: '0' },
    '01': { name: '심플바스켓 (4호 화이트)', sup: '1', supPrice: '680', qty: '900', hid: '0' },
    '02': { name: '심플바스켓 (3호 차콜)', sup: '1', supPrice: '0', qty: '900', hid: '0' },
  },
});
let seq = 0;

type Attr = { attributeTypeName: string; attributeValueName: string };
/** 쿠팡에 이미 올라간 상품(승인완료) + 시스템 기록 */
async function seedCoupang(o: { sourceTitle: string; name: string; attrs: (units: number) => Attr[]; units?: number[]; options?: string; status?: 'active' | 'paused'; reason?: string; sourceOption?: string | null; linked?: boolean }) {
  const n = ++seq;
  const x = await seedActiveListing(h, { price: 3030, salePrice: 11900 });
  const p = h.apiSource.products.get(x.d.sourceItemId)!;
  p.title = o.sourceTitle;
  if (o.options) p.options = parseDomeggookOptions(o.options, 'supply', 3030).options;
  await h.ctx.db.updateTable('source_products').set({ title: o.sourceTitle }).where('id', '=', x.listing.source_product_id).execute();
  const units = o.units ?? [1, 2];
  const sid = `SPR${n}`;
  const vids = units.map((u) => `VR${n}-${u}`);
  h.market.products.set(sid, {
    payload: {
      displayProductName: o.name, sellerProductName: o.name, generalProductName: o.name, displayCategoryCode: 80719, vendorId: 'A0', requested: true,
      items: units.map((u) => ({ itemName: `${o.name} ${u}개`, salePrice: 11900 * u, images: [{ imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: 'img-1.jpg' }], attributes: [...o.attrs(u), { attributeTypeName: '바구니 형태', attributeValueName: '' }, { attributeTypeName: '수납/정리용품 재질', attributeValueName: '플라스틱' }] })),
    },
    status: 'APPROVED', vendorItemIds: vids,
  });
  const status = o.status ?? 'active';
  for (const v of vids) h.market.items.set(v, { price: 11900, qty: 10, onSale: status === 'active' });
  const cand = o.linked ? null : await h.ctx.db.insertInto('candidates').values({ source_product_id: x.listing.source_product_id, keyword: 'k', score: 0.5, signals: '{}', gates: '[]', passed: true, run_id: 'r', status: 'listed', created_at: h.clock.now() }).returning('id').executeTakeFirstOrThrow();
  await h.ctx.db.updateTable('listings').set({
    seller_product_id: sid, vendor_item_id: vids[0], dry_run: false, candidate_id: cand?.id ?? null, title: o.name,
    status, status_reason: o.reason ?? null, paused_at: status === 'paused' ? h.clock.now() : null, source_option: o.sourceOption ?? null,
    payload: o.linked ? null : JSON.stringify({ displayProductName: o.name }),
  }).where('id', '=', x.listing.id).execute();
  for (const [i, u] of units.entries()) {
    await h.ctx.db.insertInto('listing_items').values({ listing_id: x.listing.id, unit_qty: u, item_name: `${o.name} ${u}개`, vendor_item_id: vids[i], sale_price: 11900 * u, floor_price: 8000 * u, created_at: h.clock.now() }).execute();
  }
  return { ...x, sid, vids, listingId: x.listing.id };
}
const listingOf = (id: number) => h.ctx.db.selectFrom('listings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const attrsOf = (body: any, i: number) => Object.fromEntries((body.items[i].attributes as Attr[]).map((a) => [a.attributeTypeName, a.attributeValueName]));

async function setup() {
  h = await makeHarness({ live: true });
  h.market.getCategoryMeta = async () => META;
}

describe('상품 설정 자동 점검·수정', () => {
  it('직접 멈춘 바스켓(멀티/FREE·옵션 미지정): 옵션 지정 + 구매옵션 수정 요청 → 심사 중엔 그대로 → 승인되면 다시 점검해 판매 재개', async () => {
    await setup();
    const b = await seedCoupang({
      sourceTitle: '수납 바스켓 주방리빙박스', name: '수납 바스켓 주방리빙박스', options: BASKET, status: 'paused', reason: '쿠팡에서 판매중지됨(Wing 또는 쿠팡 조치) — 확인 후 [판매재개]',
      attrs: (u) => [{ attributeTypeName: '색상', attributeValueName: '멀티' }, { attributeTypeName: '수량', attributeValueName: `${u}개` }, { attributeTypeName: '사이즈', attributeValueName: 'FREE' }],
    });
    let r = await repairListings(h.ctx);
    expect(r).toMatchObject({ requested: 1, failed: 0 });
    const body = h.market.updates[0]!;
    expect(body.sellerProductId).toBe(b.sid);
    expect(body.requested).toBe(true);
    expect(attrsOf(body, 0)).toEqual({ 색상: '화이트', 수량: '1개', 사이즈: '3호', '수납/정리용품 재질': '플라스틱' }); // 값 없는 속성은 빼고, 다른 속성은 보존
    expect(attrsOf(body, 1)).toMatchObject({ 수량: '2개', 색상: '화이트', 사이즈: '3호' });
    expect(body.items.map((i: any) => i.vendorItemId)).toEqual(b.vids); // 옵션ID 유지
    let l = await listingOf(b.listingId);
    expect(l).toMatchObject({ repair_state: 'requested', repair_resume: true, source_option: '심플바스켓 (3호 화이트)', status: 'paused' });
    expect(l.repair_note).toContain('색상: 멀티 → 화이트');
    expect(h.notifier.titles()).toContain('상품 설정 자동 수정 요청 1개(쿠팡 심사 중)');

    // 심사 중: 아무것도 하지 않음(다시 요청 안 함)
    h.clock.advanceMinutes(HOUR);
    r = await repairListings(h.ctx);
    expect(r.requested).toBe(0);
    expect(h.market.updates).toHaveLength(1);
    expect((await listingOf(b.listingId)).status).toBe('paused');

    // 승인 → 재점검 정상 → 판매 재개
    h.market.approve(b.sid);
    h.clock.advanceMinutes(HOUR);
    r = await repairListings(h.ctx);
    expect(r).toMatchObject({ completed: 1, resumed: 1 });
    l = await listingOf(b.listingId);
    expect(l).toMatchObject({ status: 'active', repair_state: null, repair_resume: false });
    for (const v of b.vids) expect(h.market.items.get(v)!.onSale).toBe(true);
    expect(h.notifier.titles()).toEqual(expect.arrayContaining(['상품 설정 수정 완료 1개', '설정 수정 확인 → 판매 재개 1개']));
    // 이후 점검: 정상 → 다시 요청 없음
    h.clock.advanceMinutes(HOUR);
    await repairListings(h.ctx);
    expect(h.market.updates).toHaveLength(1);
  });

  it('직접 멈춘 등산가방(상품명에 옵션 색상 중복): 상품명 수정 → 승인 후 재개', async () => {
    await setup();
    const g = await seedCoupang({
      sourceTitle: '휴대용 경량 방수 등산가방 오렌지', name: '휴대용 경량 방수 등산가방 오렌지', units: [1], status: 'paused', reason: '관리자 중지',
      attrs: () => [{ attributeTypeName: '색상', attributeValueName: '오렌지' }, { attributeTypeName: '사이즈', attributeValueName: 'FREE' }, { attributeTypeName: '수량', attributeValueName: '1개' }],
    });
    await repairListings(h.ctx);
    const body = h.market.updates[0]!;
    expect(body.displayProductName).toBe('휴대용 경량 방수 등산가방');
    expect(body.sellerProductName).toBe('휴대용 경량 방수 등산가방');
    expect(attrsOf(body, 0)).toMatchObject({ 색상: '오렌지' });
    expect((await listingOf(g.listingId)).title).toBe('휴대용 경량 방수 등산가방');
    h.market.approve(g.sid);
    await repairListings(h.ctx);
    expect((await listingOf(g.listingId)).status).toBe('active');
  });

  it('판매중 상품도 고치되 판매는 그대로(심사 중에도 판매중 유지)', async () => {
    await setup();
    const a = await seedCoupang({
      sourceTitle: '방수 세면파우치 블랙', name: '방수 세면파우치 블랙', units: [1],
      attrs: () => [{ attributeTypeName: '색상', attributeValueName: '블랙' }, { attributeTypeName: '사이즈', attributeValueName: 'FREE' }, { attributeTypeName: '수량', attributeValueName: '1개' }],
    });
    await repairListings(h.ctx);
    expect(h.market.updates[0]!.displayProductName).toBe('방수 세면파우치');
    expect(await listingOf(a.listingId)).toMatchObject({ status: 'active', repair_state: 'requested', repair_resume: false });
    expect(h.market.items.get(a.vids[0]!)!.onSale).toBe(true);
  });

  it('설정이 맞는 상품은 수정하지 않음, 오류 없는 직접 중지 상품은 재개하지 않고 알림만', async () => {
    await setup();
    await seedCoupang({ sourceTitle: '수납 바구니 소형', name: '수납 바구니', units: [1], attrs: () => [{ attributeTypeName: '색상', attributeValueName: '멀티' }, { attributeTypeName: '사이즈', attributeValueName: '소형' }, { attributeTypeName: '수량', attributeValueName: '1개' }] });
    const p = await seedCoupang({ sourceTitle: '수납 바구니 대형', name: '수납 바구니', units: [1], status: 'paused', reason: '관리자 중지', attrs: () => [{ attributeTypeName: '색상', attributeValueName: '멀티' }, { attributeTypeName: '사이즈', attributeValueName: '대형' }, { attributeTypeName: '수량', attributeValueName: '1개' }] });
    const r = await repairListings(h.ctx);
    expect(r.requested).toBe(0);
    expect(h.market.updates).toHaveLength(0);
    expect((await listingOf(p.listingId)).status).toBe('paused');
    expect(h.notifier.titles()).toContain('직접 멈춘 상품 1개 — 설정 오류 없음');
  });

  it('수정 후 공급처가 품절이면 재개하지 않고 공급처 사유로 → 재입고되면 동기화가 재개', async () => {
    await setup();
    const b = await seedCoupang({ sourceTitle: '등산가방 오렌지', name: '등산가방 오렌지', units: [1], status: 'paused', reason: '관리자 중지', attrs: () => [{ attributeTypeName: '색상', attributeValueName: '오렌지' }, { attributeTypeName: '사이즈', attributeValueName: 'FREE' }, { attributeTypeName: '수량', attributeValueName: '1개' }] });
    await repairListings(h.ctx);
    h.market.approve(b.sid);
    h.apiSource.products.get(b.d.sourceItemId)!.status = 'soldout';
    const r = await repairListings(h.ctx);
    expect(r).toMatchObject({ completed: 1, resumed: 0 });
    let l = await listingOf(b.listingId);
    expect(l.status).toBe('paused');
    expect(l.status_reason).toContain('공급처 품절');
    h.apiSource.products.get(b.d.sourceItemId)!.status = 'active';
    await syncListings(h.ctx);
    l = await listingOf(b.listingId);
    expect(l.status).toBe('active');
  });

  it('수정 요청 실패 → 실패 기록·알림, 간격 뒤 재시도, 최대 횟수 넘으면 중단', async () => {
    await setup();
    await h.ctx.settings.update({ repair: { maxAttempts: 2 } });
    const a = await seedCoupang({ sourceTitle: '파우치 블랙', name: '방수 파우치 블랙', units: [1], attrs: () => [{ attributeTypeName: '색상', attributeValueName: '블랙' }, { attributeTypeName: '사이즈', attributeValueName: 'FREE' }, { attributeTypeName: '수량', attributeValueName: '1개' }] });
    h.market.updateProduct = async () => ({ ok: false, retryable: false, message: '카테고리의 필수 속성이 존재하지 않습니다.' });
    let r = await repairListings(h.ctx);
    expect(r.failed).toBe(1);
    expect(await listingOf(a.listingId)).toMatchObject({ repair_state: 'failed', repair_attempts: 1 });
    expect((await listingOf(a.listingId)).repair_note).toContain('필수 속성');
    expect(h.notifier.titles()).toContain('상품 설정 수정 실패 1개');
    r = await repairListings(h.ctx);
    expect(r.checked).toBe(0); // 간격 안
    h.clock.advanceMinutes(25 * HOUR);
    await repairListings(h.ctx);
    expect((await listingOf(a.listingId)).repair_attempts).toBe(2);
    h.clock.advanceMinutes(25 * HOUR);
    r = await repairListings(h.ctx);
    expect(r.checked).toBe(0); // 최대 횟수
  });

  it('쿠팡이 수정을 반려하면 실패로 기록하고 알림', async () => {
    await setup();
    const a = await seedCoupang({ sourceTitle: '파우치 블랙', name: '방수 파우치 블랙', units: [1], attrs: () => [{ attributeTypeName: '색상', attributeValueName: '블랙' }, { attributeTypeName: '사이즈', attributeValueName: 'FREE' }, { attributeTypeName: '수량', attributeValueName: '1개' }] });
    await repairListings(h.ctx);
    h.market.products.get(a.sid)!.status = 'REJECTED';
    await repairListings(h.ctx);
    const l = await listingOf(a.listingId);
    expect(l.repair_state).toBe('failed');
    expect(l.repair_note).toContain('반려');
  });

  it('옵션 정보로 정할 수 없으면 고치지 않고 알림(멈춘 상품은 그대로)', async () => {
    await setup();
    const opts = JSON.stringify({ type: 'combination', set: [{ name: '옵션', opts: [] }], data: { '00': { name: '블랙 소형', sup: '1', qty: '9', hid: '0' }, '01': { name: '화이트 소형', sup: '1', qty: '9', hid: '0' }, '02': { name: '대형', sup: '1', supPrice: '-1000', qty: '9', hid: '0' } } });
    const a = await seedCoupang({ sourceTitle: '정리함', name: '정리함', options: opts, status: 'paused', reason: '옵션 미지정: x', attrs: (u) => [{ attributeTypeName: '색상', attributeValueName: '멀티' }, { attributeTypeName: '사이즈', attributeValueName: 'FREE' }, { attributeTypeName: '수량', attributeValueName: `${u}개` }] });
    const r = await repairListings(h.ctx);
    expect(r.unfixable).toBe(1);
    expect(h.market.updates).toHaveLength(0);
    expect((await listingOf(a.listingId)).status).toBe('paused');
    expect(h.notifier.titles()).toContain('자동으로 고칠 수 없는 상품 1개');
  });

  it('한 번에 수정 요청 수 제한, 직접 연결한 상품은 건드리지 않음', async () => {
    await setup();
    await h.ctx.settings.update({ repair: { perRun: 1 } });
    const bad = (u: number) => [{ attributeTypeName: '색상', attributeValueName: '블랙' }, { attributeTypeName: '사이즈', attributeValueName: 'FREE' }, { attributeTypeName: '수량', attributeValueName: `${u}개` }];
    await seedCoupang({ sourceTitle: 'a 블랙', name: '가방 블랙', units: [1], attrs: bad });
    await seedCoupang({ sourceTitle: 'b 블랙', name: '파우치 블랙', units: [1], attrs: bad });
    const linked = await seedCoupang({ sourceTitle: 'c 블랙', name: '지갑 블랙', units: [1], attrs: bad, linked: true });
    expect((await repairListings(h.ctx)).requested).toBe(1);
    expect((await repairListings(h.ctx)).requested).toBe(1);
    expect((await repairListings(h.ctx)).requested).toBe(0);
    expect(h.market.updates.map((b) => b.sellerProductId)).not.toContain(linked.sid);
  });

  it('긴급 정지·설정 끔이면 아무것도 하지 않음', async () => {
    await setup();
    await seedCoupang({ sourceTitle: 'a 블랙', name: '가방 블랙', units: [1], attrs: () => [] });
    await h.ctx.settings.update({ repair: { enabled: false } });
    expect((await repairListings(h.ctx)).checked).toBe(0);
    await h.ctx.settings.update({ repair: { enabled: true }, killSwitch: true });
    expect((await repairListings(h.ctx)).checked).toBe(0);
    expect(h.market.updates).toHaveLength(0);
  });
});

describe('쿠팡 상품 수정 API', () => {
  it('PUT seller-products 로 전체 JSON 전송, 응답 data.code SUCCESS 면 성공', async () => {
    const calls: Array<{ m: string; p: string; body?: any }> = [];
    let res: any = { code: '200', message: '', data: { code: 'SUCCESS', message: '', data: 7770 } };
    const client = { vendorId: 'A0', request: async (m: string, p: string, o: any = {}) => (calls.push({ m, p, body: o.body }), res) };
    const m = new CoupangMarket(client as never, async () => 'w');
    expect(await m.updateProduct({ sellerProductId: 1, items: [] })).toMatchObject({ ok: true });
    expect(calls[0]).toMatchObject({ m: 'PUT', p: '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', body: { sellerProductId: 1 } });
    res = { code: 'ERROR', message: '카테고리의 필수 속성이 존재하지 않습니다.' };
    expect(await m.updateProduct({ sellerProductId: 1 })).toMatchObject({ ok: false, message: '카테고리의 필수 속성이 존재하지 않습니다.' });
    res = { code: 'SUCCESS', data: { statusName: '승인완료', sellerProductId: 1 } };
    expect(await m.getProductDetail('1')).toMatchObject({ statusName: '승인완료' });
  });
});
