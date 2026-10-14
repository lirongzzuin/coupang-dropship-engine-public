import { afterEach, describe, expect, it } from 'vitest';
import { pollNewOrders, processPending } from '../src/modules/orders/service.js';
import { expectedMonthly, keywordMatches, learnedFactor, looksBranded, looksBulk, priceBandFactor, productFamily, profitScore } from '../src/modules/selection/demandModel.js';
import { learnedHistory, runSelection } from '../src/modules/selection/service.js';
import { reviewSlowListings } from '../src/modules/sync/service.js';
import { makeHarness, seedActiveListing, type TestHarness } from './helpers.js';

let h: TestHarness;
afterEach(async () => h && (await h.close()));

describe('수요 모델(순수 함수)', () => {
  it('키워드 일치: 복합명사는 끝 단어 기준', () => {
    expect(keywordMatches('필사노트 스케치노트 무선노트', '노트')).toBe(true);
    expect(keywordMatches('USB 노트북 자물쇠 캔싱턴락', '노트')).toBe(false);
    expect(keywordMatches('린베라 노트북 가방', '노트')).toBe(false);
    expect(keywordMatches('접이식 캠핑의자세트', '캠핑의자')).toBe(true);
    expect(keywordMatches('캠핑 경량 의자', '캠핑 의자')).toBe(true);
    expect(keywordMatches('수납 바스켓 [노트] 정리함', '노트')).toBe(false); // 괄호 안(브랜드·홍보)은 무시
  });

  it('상품 계열: 색상·규격만 다른 변형은 같은 계열', () => {
    const a = productFamily('smato 고무판 바닥매트 줄무늬매트(적색)750x450x8mm DMSR');
    const b = productFamily('smato 고무판 바닥매트 줄무늬매트(회색)750x450x8mm DMSB');
    expect(a).toBe(b);
    expect(productFamily('리빙엔젤 바닥매트 지압매트 10EA')).not.toBe(productFamily('리빙엔젤 바닥매트 물결매트 10EA'));
    expect(productFamily('수납함 블랙 대형')).toBe(productFamily('수납함 화이트 대형'));
  });

  it('브랜드·대량 표기 감지', () => {
    expect(looksBranded('3M)포스트-잇 노트(654-20A 대용량팩)')).toBe(true);
    expect(looksBranded('브레인)수납정리함(CA507B/블루)')).toBe(true);
    expect(looksBranded('접이식 리빙박스 44리터')).toBe(false);
    expect(looksBulk('리빙엔젤 바닥매트 지압매트 10EA')).toBe(true);
    expect(looksBulk('3M 포스트잇 대용량팩')).toBe(true);
    expect(looksBulk('분류표기용라벨 100매 상품라벨')).toBe(false); // 라벨 100매는 일반 소비 단위
    expect(looksBulk('수납함 3개 세트')).toBe(false);
  });

  it('가격 경쟁력: 비슷한 상품보다 쌀수록↑ 비쌀수록↓, 시장 최저가 대비, 더 싼 같은 상품 존재 시↓', async () => {
    const { priceCompetitiveness } = await import('../src/modules/selection/demandModel.js');
    expect(priceCompetitiveness(1)).toBe(1);
    expect(priceCompetitiveness(0.7)).toBeCloseTo(1.09, 2); // 중앙가보다 30% 쌈 → 가점
    expect(priceCompetitiveness(2)).toBeCloseTo(0.5, 5);
    expect(priceCompetitiveness(3)).toBeLessThan(0.2);
    expect(priceCompetitiveness(1, 0.95)).toBeCloseTo(1.3, 5); // 쿠팡 최저가 이하
    expect(priceCompetitiveness(1, 1.3)).toBeLessThan(0.6); // 최저가보다 30% 비쌈
    expect(priceCompetitiveness(1, undefined, true)).toBeCloseTo(0.7, 5); // 같은 상품을 더 싸게 들여오는 곳 있음
    expect(priceBandFactor(undefined)).toBe(0.9);
  });

  it('기대 월이익: 검색량·가격대·경쟁·브랜드/대량·학습계수 반영', () => {
    const base = { searchVolume: 10000, competition: '중간', priceRatio: 1, conversion: 1, unitProfit: 5000 };
    const r = expectedMonthly(base);
    expect(r.sales).toBeCloseTo(1.5, 2); // 기본 1.5개/월(검색 1만, 모든 보정 중립)
    expect(r.profit).toBe(7500);
    expect(expectedMonthly({ ...base, searchVolume: 40000 }).sales).toBeGreaterThan(r.sales * 2);
    expect(expectedMonthly({ ...base, competition: '높음' }).sales).toBeLessThan(r.sales);
    expect(expectedMonthly({ ...base, priceRatio: 3 }).sales).toBeLessThan(r.sales * 0.3);
    expect(expectedMonthly({ ...base, brand: true, bulk: true }).sales).toBeCloseTo(r.sales * 0.3, 2);
    expect(expectedMonthly({ ...base, learned: 3 }).sales).toBeCloseTo(r.sales * 3, 2);
    expect(expectedMonthly({ ...base, searchVolume: undefined }).sales).toBeGreaterThan(0); // 검색량 장애 → 중립
    expect(profitScore(100000)).toBeGreaterThan(profitScore(10000));
  });

  it('학습계수: 기대보다 잘 팔리면 ↑, 안 팔리면 ↓, 데이터 적으면 1 근처', () => {
    expect(learnedFactor(undefined)).toBe(1);
    expect(learnedFactor({ orders: 10, expected: 2 })).toBe(3);
    expect(learnedFactor({ orders: 0, expected: 6 })).toBe(0.25);
    expect(learnedFactor({ orders: 0, expected: 0.5 })).toBeCloseTo(0.8, 5);
  });
});

describe('선정 알고리즘(통합)', () => {
  it('같은 상품 변형은 1개만, 키워드당 한도, 브랜드·대량·엉뚱한 상품은 뒤로', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({
      selection: { autoListPerRun: 5, maxPerKeyword: 2 },
      coupang: { vendorUserId: 'w', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588', returnZipCode: '1', returnAddress: '서울' },
    });
    h.marketData.volume.set('정리함', 20000);
    h.apiSource.add({ sourceItemId: 'F1', title: '스텐 수납 정리함 블랙', price: 16000 });
    h.apiSource.add({ sourceItemId: 'F2', title: '스텐 수납 정리함 화이트', price: 16000 }); // 같은 계열
    h.apiSource.add({ sourceItemId: 'F3', title: '원목 서랍 정리함', price: 17000 });
    h.apiSource.add({ sourceItemId: 'F4', title: '브레인)사무용 정리함', price: 16500 }); // 브랜드
    h.apiSource.add({ sourceItemId: 'F5', title: '플라스틱 정리함 20개 업소용', price: 90000 }); // 대량·고가
    const r = await runSelection(h.ctx, { keywords: ['정리함'] });
    expect(r.passed).toBe(5);
    expect(r.autoListed).toBe(2); // 키워드당 2개
    const titles = (await h.ctx.db.selectFrom('listings').select('title').execute()).map((x) => x.title);
    expect(titles.filter((t) => t.includes('스텐')).length).toBe(1); // 변형 중복 없음
    expect(titles.some((t) => t.includes('업소용') || t.includes('브레인'))).toBe(false);
    const cands = await h.ctx.db.selectFrom('candidates').innerJoin('source_products', 'source_products.id', 'candidates.source_product_id')
      .select(['source_products.title', 'candidates.score', 'candidates.signals']).orderBy('candidates.score', 'desc').execute();
    expect(cands.at(-1)!.title).toContain('업소용'); // 대량·고가가 꼴찌
    const sig = typeof cands[0]!.signals === 'string' ? JSON.parse(cands[0]!.signals) : cands[0]!.signals;
    expect(sig.demand.sales).toBeGreaterThan(0);
    expect(sig.keywordMedianPrice).toBeGreaterThan(0);
    const msg = h.notifier.sent.find((x) => x.title.startsWith('상품 선정 결과'))!;
    expect(msg.body).toContain('키워드당 2개 한도');
  });

  it('실제 판매 기록이 같은 키워드 후보의 우선순위를 올림(학습)', async () => {
    h = await makeHarness({ live: true });
    h.marketData.volume.set('정리함', 10000);
    h.marketData.volume.set('바구니', 10000);
    // 과거에 '정리함'으로 올린 상품이 기대보다 잘 팔림
    const { listing, vendorItemId } = await seedActiveListing(h, { salePrice: 25900 });
    const old = new Date(h.clock.now().getTime() - 30 * 86400_000);
    const cand = await h.ctx.db.insertInto('candidates').values({ source_product_id: listing.source_product_id, keyword: '정리함', score: 0.5, signals: JSON.stringify({ demand: { sales: 1, profit: 5000 }, category: '생활용품' }), gates: '[]', passed: true, run_id: 'old', status: 'listed', created_at: old }).returning('id').executeTakeFirstOrThrow();
    await h.ctx.db.updateTable('listings').set({ candidate_id: cand.id, listed_at: old, dry_run: false }).where('id', '=', listing.id).execute();
    for (let i = 0; i < 8; i++) h.market.seedOrder({ vendorItemId, paidAmount: 25900, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    const hist = await learnedHistory(h.ctx);
    expect(hist.byKeyword.get('정리함')!.orders).toBe(8);
    h.apiSource.add({ sourceItemId: 'L1', title: '원목 수납 정리함', price: 16000, categoryPath: '생활용품>수납' });
    h.apiSource.add({ sourceItemId: 'L2', title: '원목 수납 바구니', price: 16000, categoryPath: '생활용품>수납' });
    await h.ctx.settings.update({ selection: { mode: 'manual_approve' } });
    await runSelection(h.ctx, { keywords: ['정리함', '바구니'] });
    const rows = await h.ctx.db.selectFrom('candidates').select(['keyword', 'score']).where('run_id', '!=', 'old').execute();
    const sc = (k: string) => rows.find((r) => r.keyword === k)!.score;
    expect(sc('정리함')).toBeGreaterThan(sc('바구니'));
  });
});

describe('판매 부진 교체', () => {
  it('14일 0건 → 하한가 → 10일 더 0건이면 판매종료(다음 선정에서 교체)', async () => {
    h = await makeHarness({ live: true });
    const { listing } = await seedActiveListing(h, { salePrice: 30000, markup: 0.1 });
    h.clock.advanceMinutes(60 * 24 * 15);
    expect((await reviewSlowListings(h.ctx)).lowered).toBe(1);
    h.clock.advanceMinutes(60 * 24 * 5);
    expect((await reviewSlowListings(h.ctx)).stopped).toBe(0); // 아직 10일 안 됨
    h.clock.advanceMinutes(60 * 24 * 6);
    expect((await reviewSlowListings(h.ctx)).stopped).toBe(1);
    const l = await h.ctx.db.selectFrom('listings').selectAll().where('id', '=', listing.id).executeTakeFirstOrThrow();
    expect(l.status).toBe('stopped');
    expect(h.notifier.titles().some((t) => t.includes('판매 부진'))).toBe(true);
  });
});

describe('쿠팡 등록 요청 점검', () => {
  it('필수 구매옵션(색상·사이즈·수량)을 상품명에서 채우고, 못 채우는 숫자 속성은 등록 거부', async () => {
    const { buildAttributes, AttributeError } = await import('../src/modules/listing/payload.js');
    const meta = (specs: any[]) => ({ code: '1', notices: [], requiredAttributes: specs.map((x) => x.name), requiredAttributeSpecs: specs });
    const C = { name: '색상', dataType: 'STRING' }, S = { name: '사이즈', dataType: 'STRING' }, Q = { name: '수량', dataType: 'NUMBER', basicUnit: '개', usableUnits: ['개'] };
    expect(buildAttributes(meta([C, S, Q]), '접이식 리빙박스 44리터 블랙', 2)).toEqual([
      { attributeTypeName: '색상', attributeValueName: '블랙' },
      { attributeTypeName: '사이즈', attributeValueName: '44리터' },
      { attributeTypeName: '수량', attributeValueName: '2개' },
    ]);
    expect(buildAttributes(meta([C, { name: '패션의류/잡화 사이즈', dataType: 'STRING' }]), '스웨이드 숄더백', 1)[1]!.attributeValueName).toBe('FREE');
    const V = { name: '용량', dataType: 'NUMBER', basicUnit: 'ml', usableUnits: ['ml', 'L'] };
    expect(buildAttributes(meta([V]), '텀블러 500ml', 1)[0]!.attributeValueName).toBe('500ml');
    expect(() => buildAttributes(meta([V]), '텀블러 대용량', 1)).toThrow(AttributeError);
  });

  it('실제 등록(LIVE)인데 이미지 공개 주소가 없으면 등록하지 않고 알림', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({
      listing: { convertImages: true },
      coupang: { vendorUserId: 'w', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588', returnZipCode: '1', returnAddress: '서울' },
    });
    h.marketData.volume.set('정리함', 20000);
    h.apiSource.add({ sourceItemId: 'P1', title: '원목 수납 정리함', price: 16000 });
    const r = await runSelection(h.ctx, { keywords: ['정리함'] });
    expect(r.autoListed).toBe(0);
    expect(h.notifier.titles()).toContain('자동 등록 중단: 이미지 공개 필요');
    expect(h.market.products.size).toBe(0);
  });
});

describe('아침 브리핑·개선 데이터', () => {
  it('정상이면 "모두 정상", 어제 실적·상품·할 일 + 상품별 일일 스냅샷 기록, 오래된 탈락 후보 정리', async () => {
    const { sendDailyReport } = await import('../src/modules/reports/service.js');
    h = await makeHarness({ live: true });
    const { listing, vendorItemId } = await seedActiveListing(h, { salePrice: 25900 });
    await h.ctx.db.updateTable('listings').set({ dry_run: false }).where('id', '=', listing.id).execute();
    h.market.seedOrder({ vendorItemId, paidAmount: 25900, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    // 오래된 탈락 후보(정리 대상)와 통과 후보(보관)
    const old = new Date(h.clock.now().getTime() - 90 * 86400_000);
    await h.ctx.db.insertInto('candidates').values([
      { source_product_id: listing.source_product_id, keyword: 'x', score: 0.1, signals: '{}', gates: '[]', passed: false, run_id: 'old', status: 'expired', created_at: old },
      { source_product_id: listing.source_product_id, keyword: 'y', score: 0.9, signals: '{}', gates: '[]', passed: true, run_id: 'old', status: 'expired', created_at: old },
    ]).execute();
    await h.ctx.kv.set('orders.lastPollOkAt', h.clock.now().toISOString());
    h.clock.advanceMinutes(60 * 24); // 다음 날 아침
    await h.ctx.kv.set('orders.lastPollOkAt', h.clock.now().toISOString());
    await h.ctx.settings.update({ listing: { convertImages: true } });
    const body = await sendDailyReport(h.ctx);
    expect(body).toContain('✅ 시스템: 자동 작업 모두 정상');
    expect(body).toMatch(/어제: 주문 1건 · 매출 25,900원/);
    expect(body).toContain('이미지 공개 켜기'); // 할 일 안내
    const m = await h.ctx.db.selectFrom('daily_metrics').selectAll().execute();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ listing_id: listing.id, orders: 1, revenue: 25900 });
    const left = await h.ctx.db.selectFrom('candidates').select('keyword').where('run_id', '=', 'old').execute();
    expect(left.map((x) => x.keyword)).toEqual(['y']);
  });

  it('선정 1회마다 요약 1행(탈락 사유·등록 수·모델 계수) 기록', async () => {
    h = await makeHarness({ live: true });
    h.marketData.volume.set('정리함', 20000);
    h.apiSource.add({ sourceItemId: 'R1', title: '원목 수납 정리함', price: 16000 });
    h.apiSource.add({ sourceItemId: 'R2', title: '노트북 거치대 정리함받침', price: 16000 }); // 키워드 불일치
    await h.ctx.settings.update({ selection: { mode: 'manual_approve' } });
    await runSelection(h.ctx, { keywords: ['정리함'] });
    const r = await h.ctx.db.selectFrom('selection_runs').selectAll().executeTakeFirstOrThrow();
    expect(r).toMatchObject({ evaluated: 2, passed: 1, listed: 0 });
    const fails = typeof r.fails === 'string' ? JSON.parse(r.fails) : r.fails;
    expect(fails.relevance).toBe(1);
    const model = typeof r.model === 'string' ? JSON.parse(r.model) : r.model;
    expect(model.baseSalesPer10k).toBe(1.5);
  });
});

describe('등록 사전 점검', () => {
  it('상위 후보를 임시저장으로 보내 확인하고 삭제, 초안·후보 상태는 원래대로', async () => {
    const { verifyRegistration } = await import('../src/modules/listing/service.js');
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ selection: { mode: 'manual_approve' } });
    h.marketData.volume.set('정리함', 20000);
    h.apiSource.add({ sourceItemId: 'V1', title: '원목 수납 정리함 화이트', price: 16000 });
    await runSelection(h.ctx, { keywords: ['정리함'] });
    const r = await verifyRegistration(h.ctx);
    expect(r).toMatchObject({ ok: true, deleted: true });
    expect(h.market.products.size).toBe(0); // 쿠팡 쪽 정리됨
    expect(await h.ctx.db.selectFrom('listings').selectAll().execute()).toHaveLength(0);
    const c = await h.ctx.db.selectFrom('candidates').select('status').executeTakeFirstOrThrow();
    expect(c.status).toBe('new');
  });
});

describe('가격대 우선순위(가볍게 사는 1만원대 우선, 데이터가 받쳐주면 고가도)', () => {
  it('같은 수요면 1만원대가 8~9만원대보다 앞', async () => {
    const { priceAppealFactor, rankScore } = await import('../src/modules/selection/demandModel.js');
    expect(priceAppealFactor(9900)).toBeGreaterThan(1.3);
    expect(priceAppealFactor(89000)).toBeLessThan(0.3);
    const cheap = expectedMonthly({ searchVolume: 18000, competition: '중간', priceRatio: 1, conversion: 0.8, unitProfit: 3000, salePrice: 12900 });
    const pricey = expectedMonthly({ searchVolume: 18000, competition: '중간', priceRatio: 1, conversion: 0.8, unitProfit: 11000, salePrice: 89900 });
    const w = { profit: 0.5, sales: 0.2, quality: 0.3 };
    expect(rankScore(cheap, 0.7, w)).toBeGreaterThan(rankScore(pricey, 0.7, w));
    // 고가 상품이 실제로 잘 팔린 기록(학습계수 3)이 있으면 고가가 앞
    const proven = expectedMonthly({ searchVolume: 18000, competition: '중간', priceRatio: 1, conversion: 0.8, unitProfit: 11000, salePrice: 89900, learned: 3 });
    expect(rankScore(proven, 0.7, w)).toBeGreaterThan(rankScore(cheap, 0.7, w));
    // 검색량이 훨씬 큰 고가 키워드도 앞설 수 있음
    const bigDemand = expectedMonthly({ searchVolume: 400000, competition: '낮음', priceRatio: 1, conversion: 0.8, unitProfit: 11000, salePrice: 89900 });
    expect(rankScore(bigDemand, 0.7, w)).toBeGreaterThan(rankScore(cheap, 0.7, w));
  });

  it('통합: 저가 공급 상품도 후보에 들어오고 같은 키워드에서 저가가 먼저 등록', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({
      selection: { minSupplyPrice: 2000, autoListPerRun: 1 },
      coupang: { vendorUserId: 'w', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588', returnZipCode: '1', returnAddress: '서울' },
    });
    h.marketData.volume.set('정리함', 18000);
    h.apiSource.add({ sourceItemId: 'C1', title: '투명 서랍 정리함', price: 4500 });
    h.apiSource.add({ sourceItemId: 'C2', title: '원목 대형 정리함', price: 62000 });
    const r = await runSelection(h.ctx, { keywords: ['정리함'] });
    expect(r.passed).toBe(2);
    const l = await h.ctx.db.selectFrom('listings').select(['title', 'sale_price']).executeTakeFirstOrThrow();
    expect(l.title).toContain('투명');
    expect(l.sale_price).toBeLessThan(20000);
  });
});

describe('묶음 옵션과 카테고리', () => {
  it('수량 구매옵션이 없는 카테고리는 1개 옵션만, 있으면(선택 속성이어도) 수량으로 구분', async () => {
    const { buildAttributes, supportsBundles } = await import('../src/modules/listing/payload.js');
    const noQty = { code: '1', notices: [], requiredAttributes: ['색상', '사이즈'], requiredAttributeSpecs: [{ name: '색상', dataType: 'STRING' }, { name: '사이즈', dataType: 'STRING' }], attributeNames: ['색상', '사이즈'] };
    expect(supportsBundles(noQty)).toBe(false);
    const optQty = { ...noQty, attributeNames: ['색상', '사이즈', '수량'] };
    expect(supportsBundles(optQty)).toBe(true);
    expect(buildAttributes(optQty, '창문 스티커', 2).find((a) => a.attributeTypeName === '수량')!.attributeValueName).toBe('2개');
    expect(buildAttributes(noQty, '창문 스티커', 1).some((a) => a.attributeTypeName === '수량')).toBe(false);
  });
});

describe('쿠팡 실측 반영', () => {
  it('옵션값: 의미 없는 "상세페이지 참조" 대신 기본 옵션 색상·멀티·FREE, 모르는 필수 문자 속성은 건너뜀', async () => {
    const { buildAttributes, AttributeError } = await import('../src/modules/listing/payload.js');
    const meta = { code: '1', notices: [], requiredAttributes: ['색상', '사이즈'], requiredAttributeSpecs: [{ name: '색상', dataType: 'STRING' }, { name: '사이즈', dataType: 'STRING' }], attributeNames: ['색상', '사이즈'] };
    expect(buildAttributes(meta, '창문 스티커', 1)).toEqual([{ attributeTypeName: '색상', attributeValueName: '멀티' }, { attributeTypeName: '사이즈', attributeValueName: 'FREE' }]);
    expect(buildAttributes(meta, '창문 스티커', 1, '네이비 / L')[0]!.attributeValueName).toBe('네이비');
    const model = { ...meta, requiredAttributeSpecs: [{ name: '모델명', dataType: 'STRING' }] };
    expect(() => buildAttributes(model, '창문 스티커', 1)).toThrow(AttributeError);
  });

  it('오너클랜 옵션 여러 개: 가장 싼 재고 있는 옵션을 기본으로', async () => {
    const { pickDefaultOption } = await import('../src/adapters/ownerclan/source.js');
    expect(pickDefaultOption([{ name: '블랙', price: 9000, stock: 0 }, { name: '화이트', price: 9000, stock: 30 }, { name: '대형', price: 12000, stock: 99 }])!.name).toBe('화이트');
  });

  it('사전 점검: 쿠팡이 저장 중이라 삭제를 거부하면 잠시 후 재시도', async () => {
    const { verifyRegistration, setVerifyRetryMs } = await import('../src/modules/listing/service.js');
    setVerifyRetryMs(1);
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ selection: { mode: 'manual_approve' } });
    h.marketData.volume.set('정리함', 20000);
    h.apiSource.add({ sourceItemId: 'V2', title: '원목 수납 정리함', price: 16000 });
    await runSelection(h.ctx, { keywords: ['정리함'] });
    let calls = 0;
    const orig = h.market.deleteProduct.bind(h.market);
    h.market.deleteProduct = async (id: string) => (++calls < 3 ? { ok: false, retryable: true, message: '저장중' } : orig(id));
    const r = await verifyRegistration(h.ctx);
    expect(r).toMatchObject({ ok: true, deleted: true });
    expect(calls).toBe(3);
  });
});

describe('가격 경쟁력 통합', () => {
  it('같은 상품이면 더 싸게 들여오는 공급처 쪽이 앞서고, 출고 빠른 상품이 앞섬', async () => {
    h = await makeHarness({ live: true });
    await h.ctx.settings.update({ selection: { mode: 'manual_approve' } });
    h.marketData.volume.set('정리함', 18000);
    h.apiSource.add({ sourceItemId: 'S1', title: '투명 서랍 정리함', price: 6000, prepDays: 1 });
    h.manualSource.add({ sourceItemId: 'S2', title: '투명 서랍 정리함 블랙', price: 7500, prepDays: 1 }); // 같은 상품(색상만 다름), 더 비쌈
    h.apiSource.add({ sourceItemId: 'S3', title: '패브릭 서랍 정리함', price: 6000, prepDays: 3 }); // 출고 느림
    await runSelection(h.ctx, { keywords: ['정리함'] });
    const rows = await h.ctx.db.selectFrom('candidates').innerJoin('source_products', 'source_products.id', 'candidates.source_product_id')
      .select(['source_products.source_item_id as id', 'candidates.score']).execute();
    const sc = (id: string) => rows.find((r) => r.id === id)!.score;
    expect(sc('S1')).toBeGreaterThan(sc('S2'));
    expect(sc('S1')).toBeGreaterThan(sc('S3'));
  });
});
