import { afterEach, describe, expect, it } from 'vitest';
import { upsertSourceProduct } from '../src/modules/catalog.js';
import { listingVariants, planItems, sellableVariants } from '../src/modules/listing/items.js';
import { refreshListingStatuses } from '../src/modules/listing/service.js';
import { auditListing } from '../src/modules/monitor/repair.js';
import { reconcileMarketState } from '../src/modules/monitor/service.js';
import { pollNewOrders, processPending } from '../src/modules/orders/service.js';
import { runSelection } from '../src/modules/selection/service.js';
import { syncListings } from '../src/modules/sync/service.js';
import { defaultSettings } from '../src/config/settings.js';
import type { CategoryMeta } from '../src/ports/market.js';
import type { SourceOption } from '../src/ports/source.js';
import { makeHarness, orderByBox, seedActiveListing, type TestHarness } from './helpers.js';

let h: TestHarness;
afterEach(async () => h && (await h.close()));
const COUPANG = { vendorUserId: 'w', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588-0000', returnZipCode: '04524', returnAddress: '서울' };
const META: CategoryMeta = {
  code: '1', notices: [], requiredAttributes: ['색상', '사이즈', '수량'], attributeNames: ['색상', '사이즈', '수량'],
  requiredAttributeSpecs: [{ name: '색상', dataType: 'STRING' }, { name: '사이즈', dataType: 'STRING' }, { name: '수량', dataType: 'NUMBER', basicUnit: '개', usableUnits: ['개'] }],
};
const opt = (color: string, size: string, price: number, stock: number | null = 50): SourceOption => ({ name: `${color} / ${size}`, price, stock, attrs: [{ name: '색상', value: color }, { name: '사이즈', value: size }] });
const attrsOf = (it: any) => Object.fromEntries(it.attributes.map((a: any) => [a.attributeTypeName, a.attributeValueName]));

/** 색상×사이즈 4개 옵션 상품을 자동 선정으로 등록 → 승인까지 */
async function registerVariantProduct(options: SourceOption[], extra: Record<string, unknown> = {}) {
  h = await makeHarness({ live: true });
  await h.ctx.settings.update({ coupang: COUPANG, ...extra });
  h.market.getCategoryMeta = async () => META;
  h.apiSource.add({ sourceItemId: 'V1', title: '논슬립 수납 정리함', price: Math.min(...options.map((o) => o.price)), stock: 200, options });
  h.marketData.volume.set('수납 정리함', 20000);
  h.marketData.lowest.set('수납 정리함', 40000);
  const r = await runSelection(h.ctx, { keywords: ['수납 정리함'] });
  expect(r.autoListed).toBe(1);
  const l = await h.ctx.db.selectFrom('listings').selectAll().where('status', '=', 'pending_approval').executeTakeFirstOrThrow();
  const sent = h.market.products.get(l.seller_product_id!)!.payload;
  h.market.autoApprove = true;
  await refreshListingStatuses(h.ctx);
  const items = await h.ctx.db.selectFrom('listing_items').selectAll().where('listing_id', '=', l.id).execute();
  return { l: await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', l.id).executeTakeFirstOrThrow(), sent, items };
}
const itemOf = (items: any[], option: string, units = 1) => items.find((i) => i.source_option === option && i.unit_qty === units)!;

describe('여러 공급처 옵션 계획', () => {
  it('재고 있는 옵션만 싼 순으로(최대 maxVariants), 하나뿐이거나 꺼져 있으면 기존 방식', () => {
    const s = defaultSettings();
    const d = { options: [opt('블랙', 'M', 9000), opt('화이트', 'M', 8000), opt('그레이', 'M', 8500, 0)] } as any;
    expect(sellableVariants(s, d).map((o) => o.name)).toEqual(['화이트 / M', '블랙 / M']);
    expect(sellableVariants({ ...s, listing: { ...s.listing, maxVariants: 1 } }, d).map((o) => o.name)).toEqual(['화이트 / M']);
    expect(sellableVariants({ ...s, listing: { ...s.listing, multiVariant: false } }, d)).toEqual([]);
    expect(sellableVariants(s, { options: [opt('블랙', 'M', 9000)] } as any)).toEqual([]);
    expect(sellableVariants(s, { options: [opt('블랙', 'M', 9000), opt('화이트', 'M', 8000)], optionIssue: 'x' } as any)).toEqual([]);
  });

  it('옵션별 원가로 하한가·판매가, 옵션 수 상한이면 큰 묶음부터 뺌', async () => {
    h = await makeHarness({ live: true });
    const d = h.apiSource.add({ sourceItemId: 'P', title: '정리함', price: 8000, options: [opt('화이트', 'M', 8000), opt('블랙', 'L', 12000)] });
    const sp = await upsertSourceProduct(h.ctx, 'mockapi', d);
    const plans = await planItems(h.ctx, sp, '정리함', 0, null, ['화이트 / M', '블랙 / L']);
    const one = (o: string) => plans.find((p) => p.option === o && p.units === 1)!;
    expect(one('블랙 / L').floor).toBeGreaterThan(one('화이트 / M').floor); // 비싼 옵션은 하한가도 높음
    expect(plans.length).toBe(6); // 2옵션 × 1·2·3개
    await h.ctx.settings.update({ listing: { maxItems: 4 } });
    const capped = await planItems(h.ctx, sp, '정리함', 0, null, ['화이트 / M', '블랙 / L']);
    expect(capped.map((p) => p.units).sort()).toEqual([1, 1, 2, 2]); // 3개 묶음부터 뺌
  });
});

describe('등록·주문', () => {
  it('공급처 옵션 4개 → 쿠팡 옵션(옵션별 색상·사이즈·가격·재고), 상품명엔 옵션 단어 없음, 고객이 고른 옵션으로 발주', async () => {
    const { l, sent, items } = await registerVariantProduct([opt('화이트', 'M', 8000, 40), opt('화이트', 'L', 9000, 30), opt('블랙', 'M', 8000, 20), opt('블랙', 'L', 9000, 10)]);
    const ones = sent.items.filter((it: any) => attrsOf(it)['수량'] === '1개');
    expect(ones.map((it: any) => it.itemName).sort()).toEqual(['블랙 L 1개', '블랙 M 1개', '화이트 L 1개', '화이트 M 1개']);
    expect(new Set(sent.items.map((it: any) => it.itemName)).size).toBe(sent.items.length); // 옵션명 중복 없음
    const priceOf = (name: string) => sent.items.find((it: any) => it.itemName === name).salePrice;
    expect(priceOf('화이트 L 1개')).toBeGreaterThan(priceOf('화이트 M 1개')); // 원가 비싼 옵션은 더 비싸게
    expect(sent.items.find((it: any) => it.itemName === '블랙 L 1개').maximumBuyCount).toBe(10); // 옵션별 재고
    expect(sent.displayProductName).toBe('논슬립 수납 정리함');
    expect(l.status).toBe('active');
    expect(await listingVariants(h.ctx, l)).toHaveLength(4);
    for (const it of items) expect(it.vendor_item_id).toBeTruthy(); // 승인 시 옵션명으로 옵션ID 매칭
    // 고객이 "블랙 L 1개" 주문 → 공급처 옵션 "블랙 / L"로 발주
    const blackL = itemOf(items, '블랙 / L');
    const line = h.market.seedOrder({ vendorItemId: blackL.vendor_item_id, paidAmount: blackL.sale_price, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('PURCHASED');
    expect([...h.apiSource.orders.values()][0]!.req.option).toBe('블랙 / L');
  });

  it('구매옵션이 겹치는 옵션은 빼고 등록(상품 전체는 등록)', async () => {
    // "화이트 / M"과 "화이트 / M 리필" → 둘 다 화이트·M → 뒤 것은 뺌
    const dup: SourceOption = { name: '화이트 / M 리필', price: 8100, stock: 30, attrs: [{ name: '색상', value: '화이트' }, { name: '사이즈', value: 'M' }] };
    const { sent, items } = await registerVariantProduct([opt('화이트', 'M', 8000), dup, opt('블랙', 'M', 8000)]);
    const combos = sent.items.map((it: any) => `${attrsOf(it)['색상']}/${attrsOf(it)['사이즈']}/${attrsOf(it)['수량']}`);
    expect(new Set(combos).size).toBe(combos.length);
    expect(items.some((i) => i.source_option === '화이트 / M 리필')).toBe(false);
  });
});

describe('옵션별 판매 관리', () => {
  it('한 옵션만 품절 → 그 옵션만 판매중지, 재입고 → 재개 / 모두 품절 → 상품 판매중지 → 재입고 → 재개(멈춘 옵션은 그대로)', async () => {
    const { l, items } = await registerVariantProduct([opt('화이트', 'M', 8000), opt('블랙', 'M', 8000)]);
    const p = h.apiSource.products.get('V1')!;
    const w = itemOf(items, '화이트 / M'), b = itemOf(items, '블랙 / M');
    p.options![1]!.stock = 0; // 블랙 품절
    await syncListings(h.ctx);
    expect(h.market.items.get(b.vendor_item_id)!.onSale).toBe(false);
    expect(h.market.items.get(w.vendor_item_id)!.onSale).toBe(true);
    let row = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', l.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('active');
    expect((await h.ctx.db.selectFrom('listing_items').selectAll().where('id', '=', b.id).executeTakeFirstOrThrow()).item_status).toBe('paused');
    // 재입고 → 그 옵션 재개
    p.options![1]!.stock = 50;
    await syncListings(h.ctx);
    expect(h.market.items.get(b.vendor_item_id)!.onSale).toBe(true);
    // 모두 품절 → 상품 판매중지
    p.options![0]!.stock = 0;
    p.options![1]!.stock = 0;
    await syncListings(h.ctx);
    row = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', l.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('paused');
    expect(row.status_reason).toContain('모두 품절');
    // 화이트만 재입고 → 상품 재개, 블랙은 계속 멈춤
    p.options![0]!.stock = 50;
    await syncListings(h.ctx);
    row = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', l.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('active');
    expect(h.market.items.get(w.vendor_item_id)!.onSale).toBe(true);
    expect(h.market.items.get(b.vendor_item_id)!.onSale).toBe(false);
  });

  it('옵션 원가 상승 → 그 옵션 가격만 올림, 공급처에서 옵션이 없어지면 그 옵션만 중지', async () => {
    const { items } = await registerVariantProduct([opt('화이트', 'M', 8000), opt('블랙', 'M', 8000)]);
    const p = h.apiSource.products.get('V1')!;
    const w = itemOf(items, '화이트 / M'), b = itemOf(items, '블랙 / M');
    p.options![1]!.price = 9500;
    await syncListings(h.ctx);
    expect(h.market.items.get(b.vendor_item_id)!.price).toBeGreaterThan(b.sale_price);
    expect(h.market.items.get(w.vendor_item_id)!.price).toBe(w.sale_price);
    p.options = [p.options![0]!];
    await syncListings(h.ctx);
    const bi = await h.ctx.db.selectFrom('listing_items').selectAll().where('id', '=', b.id).executeTakeFirstOrThrow();
    expect(bi.item_status).toBe('paused');
    expect(bi.item_reason).toContain('없어짐');
    expect(h.market.items.get(w.vendor_item_id)!.onSale).toBe(true);
  });

  it('품절 옵션 주문 → 발주 안 함, 그 옵션만 판매중지(다른 옵션은 계속 판매)', async () => {
    const { items } = await registerVariantProduct([opt('화이트', 'M', 8000), opt('블랙', 'M', 8000)]);
    const p = h.apiSource.products.get('V1')!;
    const w = itemOf(items, '화이트 / M'), b = itemOf(items, '블랙 / M');
    p.options![1]!.stock = 0;
    const line = h.market.seedOrder({ vendorItemId: b.vendor_item_id, paidAmount: b.sale_price, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('OUT_OF_STOCK');
    expect(h.apiSource.orders.size).toBe(0);
    expect(h.market.items.get(b.vendor_item_id)!.onSale).toBe(false);
    expect(h.market.items.get(w.vendor_item_id)!.onSale).toBe(true);
    expect(h.notifier.sent.find((m) => m.title === '품절 주문 발생')!.body).toContain('이 옵션(블랙 / M)만');
  });

  it('설정 점검: 옵션마다 자기 색상·사이즈로 비교(정상이면 수정 없음, 한 옵션만 틀리면 그 옵션만)', async () => {
    const { l, items } = await registerVariantProduct([opt('화이트', 'M', 8000), opt('블랙', 'M', 8000)]);
    let a = await auditListing(h.ctx, l);
    expect(a.changes).toEqual([]);
    // 쿠팡에서 블랙 옵션의 색상이 '멀티'로 바뀐 상황
    const prod = h.market.products.get(l.seller_product_id!)!;
    const b = itemOf(items, '블랙 / M');
    const idx = prod.vendorItemIds.indexOf(b.vendor_item_id);
    prod.payload.items[idx].attributes = prod.payload.items[idx].attributes.map((x: any) => (x.attributeTypeName === '색상' ? { ...x, attributeValueName: '멀티' } : x));
    a = await auditListing(h.ctx, l);
    expect(a.changes).toEqual(['1개 옵션 색상: 멀티 → 블랙']);
  });
});

describe('쿠팡에서 삭제한 상품 반영(실제 응답 형태)', () => {
  it('삭제된 상품: 옵션 조회는 정상(onSale=false), 상품 조회는 상품삭제 → 판매종료(쿠팡에서 삭제됨)', async () => {
    h = await makeHarness({ live: true });
    const x = await seedActiveListing(h);
    await h.ctx.db.updateTable('listings').set({ dry_run: false }).where('id', '=', x.listing.id).execute();
    // 실측 형태: 옵션은 onSale=false 로 정상 응답, 상품 조회만 '상품삭제'
    h.market.items.get(x.vendorItemId)!.onSale = false;
    h.market.deletedInWing.add(x.listing.seller_product_id!);
    const r = await reconcileMarketState(h.ctx);
    expect(r.deleted).toBe(1);
    const l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', x.listing.id).executeTakeFirstOrThrow();
    expect(l.status).toBe('stopped');
    expect(l.status_reason).toContain('쿠팡에서 삭제됨');
  });

  it('이미 "쿠팡에서 판매중지됨"으로 잘못 남아 있던 상품도 다음 대조에서 삭제로 정리', async () => {
    h = await makeHarness({ live: true });
    const x = await seedActiveListing(h);
    await h.ctx.db.updateTable('listings').set({ dry_run: false, status: 'paused', status_reason: '쿠팡에서 판매중지됨(Wing 또는 쿠팡 조치) — 확인 후 [판매재개]' }).where('id', '=', x.listing.id).execute();
    h.market.items.get(x.vendorItemId)!.onSale = false;
    h.market.deletedInWing.add(x.listing.seller_product_id!);
    await reconcileMarketState(h.ctx);
    expect((await h.ctx.db.selectFrom('listings').select(['status', 'status_reason']).where('id', '=', x.listing.id).executeTakeFirstOrThrow()).status_reason).toContain('쿠팡에서 삭제됨');
  });

  it('판매중지만 한 상품(삭제 아님)은 삭제로 보지 않음', async () => {
    h = await makeHarness({ live: true });
    const x = await seedActiveListing(h);
    await h.ctx.db.updateTable('listings').set({ dry_run: false }).where('id', '=', x.listing.id).execute();
    h.market.items.get(x.vendorItemId)!.onSale = false;
    const r = await reconcileMarketState(h.ctx);
    expect(r.deleted ?? 0).toBe(0);
    expect((await h.ctx.db.selectFrom('listings').select('status_reason').where('id', '=', x.listing.id).executeTakeFirstOrThrow()).status_reason).toContain('쿠팡에서 판매중지됨');
  });
});

describe('기존 상품 호환', () => {
  it('009: 기존 옵션은 고정 옵션 방식(source_option=\'\') 그대로, 동기화·가격 변경 정상', async () => {
    h = await makeHarness({ live: true });
    const x = await seedActiveListing(h, { price: 15000, salePrice: 24000 });
    await h.ctx.db.insertInto('listing_items').values({ listing_id: x.listing.id, unit_qty: 1, item_name: '1개', vendor_item_id: x.vendorItemId, sale_price: 24000, floor_price: 22000, created_at: h.clock.now() }).execute();
    const it = await h.ctx.db.selectFrom('listing_items').selectAll().where('listing_id', '=', x.listing.id).executeTakeFirstOrThrow();
    expect(it).toMatchObject({ source_option: '', item_status: 'active' });
    expect(await listingVariants(h.ctx, x.listing)).toEqual([]);
    h.apiSource.products.get(x.d.sourceItemId)!.price = 17000;
    const r = await syncListings(h.ctx);
    expect(r.repriced).toBe(1);
  });
});
