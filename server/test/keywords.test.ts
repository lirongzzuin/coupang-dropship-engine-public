import { afterEach, describe, expect, it } from 'vitest';
import { categoryPhrases, extractPhrases, keywordScore, tokenize } from '../src/modules/keywords/phrases.js';
import { discoverKeywords, pickKeywordsForRun, setKeywordStatus } from '../src/modules/keywords/service.js';
import { runSelection } from '../src/modules/selection/service.js';
import { makeHarness, type TestHarness } from './helpers.js';

describe('키워드 추출(순수 함수)', () => {
  it('홍보·수량·색상 단어 제거, 괄호 내용 제거', () => {
    expect(tokenize('[무료배송] 접이식 수납 정리함 3단 대용량 블랙 (특가)', new Set(['무료배송', '대용량', '블랙']))).toEqual(['접이식', '수납', '정리함']);
  });
  it('여러 상품명에서 반복되는 1~2어절 표현을 빈도순으로(2어절 우선)', () => {
    const titles = ['접이식 수납 정리함 3단', '원목 수납 정리함 서랍형', '수납 정리함 대형 블랙', '캠핑 의자 경량', '패브릭 수납 정리함'];
    // 판매자 상호 접두어("스토어 연 …")는 키워드가 아님
    expect(extractPhrases(['스토어 연 샤워헤드 교체', '스토어 연 이동식행거', '스토어 연 철제책장'], { minDf: 2 }).map((x) => x.phrase)).not.toContain('스토어');
    const p = extractPhrases(titles, { limit: 3, minDf: 2 });
    expect(p[0]).toEqual({ phrase: '수납 정리함', df: 4 });
    expect(p.map((x) => x.phrase)).toContain('정리함');
  });
  it('카테고리 이름 분해', () => {
    expect(categoryPhrases('수납/정리용품')).toEqual(['수납', '정리용품']);
    expect(categoryPhrases('기타 잡화')).toEqual(['잡화']);
  });
  it('키워드 점수: 적정 검색량·낮은 경쟁이 높음, 성과 반영', () => {
    const base = { runs: 0, passed_total: 0, listed_total: 0 };
    const sweet = keywordScore({ ...base, volume: 10000, competition: '낮음' });
    expect(sweet).toBeGreaterThan(keywordScore({ ...base, volume: 200000, competition: '낮음' }));
    expect(sweet).toBeGreaterThan(keywordScore({ ...base, volume: 10000, competition: '높음' }));
    expect(keywordScore({ volume: 10000, competition: '낮음', runs: 3, passed_total: 9, listed_total: 2 })).toBeGreaterThan(keywordScore({ volume: 10000, competition: '낮음', runs: 3, passed_total: 0, listed_total: 0 }));
  });
});

let h: TestHarness;
afterEach(async () => h && (await h.close()));

async function setupDiscovery() {
  h = await makeHarness({ live: true });
  await h.ctx.settings.update({ selection: { mode: 'manual_approve' }, discovery: { categoriesPerRun: 5, keywordsPerRun: 5, minVolume: 1000, maxVolume: 100000, supplyCheck: { enabled: false } } });
  h.apiSource.categories = [
    { code: '12_00_00_00_00', name: '생활용품', path: '생활용품', leaf: false },
    { code: '12_03_00_00_00', name: '수납/정리', path: '생활용품>수납/정리', leaf: false },
    { code: '16_02_00_00_00', name: '과자', path: '식품>과자', leaf: false }, // 허용 대분류 아님
    { code: '12_09_00_00_00', name: '충전기', path: '생활용품>충전기', leaf: false }, // 차단 이름
  ];
  h.apiSource.popular.set('12_03_00_00_00', ['접이식 수납 정리함 3단', '원목 수납 정리함', '수납 정리함 대형', '서랍 수납 정리함', '패브릭 바구니'].map((t, i) => ({ sourceItemId: `P${i}`, title: t, url: '', price: 9000, shippingFee: 3000 })));
  h.marketData.stats.set('수납 정리함', [{ keyword: '수납정리함', volume: 12000, competition: '낮음' }, { keyword: '서랍정리함', volume: 8000, competition: '중간' }, { keyword: '옷정리함', volume: 300000, competition: '높음' }]);
  h.marketData.stats.set('정리함', [{ keyword: '정리함', volume: 40000, competition: '중간' }, { keyword: '나이키정리함', volume: 5000, competition: '낮음' }]);
  h.marketData.stats.set('수납', [{ keyword: '수납', volume: 90000, competition: '높음' }, { keyword: '사직서', volume: 9000, competition: '중간' }, { keyword: '수납장추천', volume: 7000, competition: '낮음' }, { keyword: '수납장', volume: 20000, competition: '낮음' }]);
}

describe('키워드 자동 발굴 → 상품 선정', () => {
  it('허용 카테고리만 순회 → 상품명 표현 → 검색량 검증 → 필터·점수 → 풀 저장', async () => {
    await setupDiscovery();
    const r = await discoverKeywords(h.ctx);
    expect(r.categories).toBe(1); // 식품·충전기 제외, 대분류(1단계) 제외
    expect(h.marketData.statsCalls.flat()).toEqual(expect.arrayContaining(['수납', '수납 정리함', '정리함']));
    const rows = await h.ctx.db.selectFrom('keywords').selectAll().orderBy('score', 'desc').execute();
    const names = rows.map((r) => r.keyword);
    expect(names).toContain('수납 정리함'); // 원래 띄어쓰기 형태 유지
    expect(names).toContain('서랍정리함'); // 연관 키워드
    expect(names).toContain('정리함');
    expect(names).not.toContain('옷정리함'); // 검색량 상한 초과·경쟁 높음
    expect(names).not.toContain('수납'); // 경쟁 높음
    expect(names).not.toContain('나이키정리함'); // 상표
    expect(names).not.toContain('사직서'); // 힌트와 무관한 연관어
    expect(names).not.toContain('수납장추천'); // 정보성 검색어
    expect(names).toContain('수납장'); // 힌트와 겹치는 연관어
    expect(rows.find((x) => x.keyword === '수납 정리함')!.origin).toBe('title');
    expect(rows.find((x) => x.keyword === '서랍정리함')!.origin).toBe('related');
    // 검색량 이력 저장(월별 추이용)
    const hist = await h.ctx.db.selectFrom('market_signals').select('keyword').where('kind', '=', 'search_volume').execute();
    expect(hist.length).toBe(rows.length);
  });

  it('시드 없이 자동 모드로 선정: 풀이 비면 먼저 발굴, 결과를 키워드 성과에 반영, 반복 실패 키워드는 자동 중지', async () => {
    await setupDiscovery();
    h.apiSource.add({ sourceItemId: 'S1', title: '수납 정리함 3단 원목', price: 15000 });
    const r = await runSelection(h.ctx);
    expect(r.keywords).toBeGreaterThan(0);
    expect(r.passed).toBeGreaterThan(0);
    const k = await h.ctx.db.selectFrom('keywords').selectAll().where('keyword', '=', '수납 정리함').executeTakeFirstOrThrow();
    expect(k.runs).toBe(1);
    expect(k.passed_total).toBeGreaterThan(0);
    expect(k.last_used_at).not.toBeNull();
    // '서랍정리함'은 공급처 상품이 없어 매번 0건 → 재사용 간격을 0으로 두고 3회 돌리면 자동 일시중지
    await h.ctx.settings.update({ discovery: { reuseDays: 0 } });
    h.clock.advanceMinutes(60);
    await runSelection(h.ctx);
    h.clock.advanceMinutes(60);
    await runSelection(h.ctx);
    const empty = await h.ctx.db.selectFrom('keywords').selectAll().where('keyword', '=', '서랍정리함').executeTakeFirstOrThrow();
    expect(empty.status).toBe('paused');
    expect(empty.note).toMatch(/통과 후보 없음/);
  });

  it('고정·제외: 고정 키워드는 항상 포함되고 설정 시드와 동기화, 제외 키워드는 다시 안 씀', async () => {
    await setupDiscovery();
    await discoverKeywords(h.ctx);
    await setKeywordStatus(h.ctx, '캠핑 의자', 'pinned');
    await setKeywordStatus(h.ctx, '정리함', 'blocked');
    expect((await h.ctx.settings.get()).selection.seedKeywords).toContain('캠핑 의자');
    const picked = await pickKeywordsForRun(h.ctx);
    expect(picked).toContain('캠핑 의자');
    expect(picked).not.toContain('정리함');
    await setKeywordStatus(h.ctx, '캠핑 의자', 'active');
    expect((await h.ctx.settings.get()).selection.seedKeywords).not.toContain('캠핑 의자');
  });

  it('수동 모드: 시드 키워드만 사용(발굴 안 함)', async () => {
    await setupDiscovery();
    await h.ctx.settings.update({ selection: { keywordMode: 'manual', seedKeywords: ['캠핑 의자'], expandRelatedPerSeed: 0 } });
    const r = await runSelection(h.ctx);
    expect(r.keywords).toBe(1);
    expect(h.marketData.statsCalls).toHaveLength(0);
  });

  it('카테고리는 대분류를 번갈아 순환', async () => {
    await setupDiscovery();
    await h.ctx.settings.update({ discovery: { categoriesPerRun: 2, allowTopCategories: ['생활용품', '패션잡화'], blockedCategoryNames: [] } });
    h.apiSource.categories = [
      { code: '12_01_00_00_00', name: 'A1', path: '생활용품>A1', leaf: true }, { code: '12_02_00_00_00', name: 'A2', path: '생활용품>A2', leaf: true },
      { code: '01_01_00_00_00', name: 'B1', path: '패션잡화>B1', leaf: true },
    ];
    const seen: string[] = [];
    h.apiSource.popularItems = async (code: string) => (seen.push(code), []);
    await discoverKeywords(h.ctx);
    expect(seen).toEqual(['12_01_00_00_00', '01_01_00_00_00']);
    await discoverKeywords(h.ctx);
    expect(seen.slice(2)).toEqual(['12_02_00_00_00', '12_01_00_00_00']);
  });

  it('검색광고 키가 없으면 발굴은 안전하게 건너뜀', async () => {
    await setupDiscovery();
    (h.ctx.marketData as any).keywordStats = undefined;
    const r = await discoverKeywords(h.ctx);
    expect(r.errors.join()).toMatch(/검색광고 키/);
    expect(await h.ctx.db.selectFrom('keywords').selectAll().execute()).toHaveLength(0);
  });
});

describe('키워드 품질: 공급처에서 파는 상품인지 확인', () => {
  it('연관 키워드는 공급처 상품명에 3개 이상 있어야 채택, 공급 없음은 기억, 카드·바우처류는 제외, 예전 미사용 키워드도 재확인', async () => {
    await setupDiscovery();
    await h.ctx.settings.update({ discovery: { supplyCheck: { enabled: true, minMatches: 3, perRun: 40 } } });
    for (let i = 0; i < 3; i++) h.apiSource.add({ sourceItemId: `J${i}`, title: `원목 수납장 ${i}단`, price: 15000 });
    for (let i = 0; i < 3; i++) h.apiSource.add({ sourceItemId: `N${i}`, title: `노트북가방 서류가방 ${i}`, price: 15000 });
    h.apiSource.add({ sourceItemId: 'D1', title: '서랍정리함 하나', price: 15000 }); // 1개뿐 → 부족
    h.marketData.stats.set('정리함', [{ keyword: '정리함', volume: 40000, competition: '중간' }, { keyword: '농협법인카드', volume: 5000, competition: '낮음' }]);
    // 예전 규칙으로 들어온 미사용 연관 키워드
    const now = h.clock.now();
    await h.ctx.db.insertInto('keywords').values([
      { keyword: '고사양노트북', origin: 'related', status: 'active', volume: 3000, score: 0.5, discovered_at: now },
      { keyword: '노트북가방', origin: 'related', status: 'active', volume: 3000, score: 0.5, discovered_at: now },
    ]).execute();
    const r = await discoverKeywords(h.ctx);
    const names = (await h.ctx.db.selectFrom('keywords').select('keyword').execute()).map((x) => x.keyword);
    expect(names).toContain('수납장'); // 공급처 상품 3개
    expect(names).not.toContain('서랍정리함'); // 1개뿐
    expect(names).not.toContain('농협법인카드'); // 카드류
    expect(names).toContain('수납 정리함'); // 상품명에서 나온 키워드는 확인 없이 채택
    expect(names).not.toContain('고사양노트북'); // 예전 키워드 재확인 → 정리
    expect(names).toContain('노트북가방');
    expect((await h.ctx.db.selectFrom('keywords').select('note').where('keyword', '=', '노트북가방').executeTakeFirstOrThrow()).note).toBe('공급처 상품 확인');
    expect(r.noSupply).toBe(2);
    // 공급 없음은 기억 → 다음 발굴에서 같은 검색 안 함
    const calls: string[] = [];
    const orig = h.apiSource.search.bind(h.apiSource);
    h.apiSource.search = async (k: string, o?: any) => (calls.push(k), orig(k, o));
    await discoverKeywords(h.ctx);
    expect(calls).not.toContain('서랍정리함');
    expect(calls).not.toContain('노트북가방'); // 이미 확인된 키워드
  });

  it('검색 한도: 새 키워드는 한도의 3/4까지만 확인하고 나머지는 다음 발굴로(공급 없음으로 세지 않음), 남은 몫은 예전 키워드 재확인', async () => {
    await setupDiscovery();
    await h.ctx.settings.update({ discovery: { supplyCheck: { enabled: true, minMatches: 3, perRun: 4 } } });
    h.manualSource.search = async () => [];
    const searched: string[] = [];
    h.apiSource.search = async (k: string) => (searched.push(k), []);
    await h.ctx.db.insertInto('keywords').values({ keyword: '예전키워드', origin: 'related', status: 'active', volume: 3000, score: 0.1, discovered_at: h.clock.now() }).execute();
    const r = await discoverKeywords(h.ctx);
    // 한도 4: 새 키워드 몫 3회(서랍정리함 2개 공급처 = 2회 → 공급 없음, 수납장 1회만 → 판단 보류), 재확인 몫 1회(예전키워드 일부만 → 보류)
    expect(r.noSupply).toBe(1);
    expect(r.supplyDeferred).toBe(1);
    expect(searched.length).toBe(3); // apiSource 검색: 서랍정리함·수납장·예전키워드
    const names = (await h.ctx.db.selectFrom('keywords').select('keyword').execute()).map((x) => x.keyword);
    expect(names).toContain('예전키워드'); // 다 못 봤으니 지우지 않음
    expect(names).not.toContain('수납장'); // 이번엔 추가 안 함(다음 발굴에서 다시 확인)
  });

  it('시간 한도(maxSeconds)를 넘으면 공급처 검색을 멈추고 나머지는 다음 발굴로', async () => {
    await setupDiscovery();
    await h.ctx.settings.update({ discovery: { supplyCheck: { enabled: true, minMatches: 3, perRun: 80, maxSeconds: 0 } } });
    const searched: string[] = [];
    h.manualSource.search = h.apiSource.search = async (k: string) => (searched.push(k), []);
    const r = await discoverKeywords(h.ctx);
    expect(searched).toEqual([]);
    expect(r.noSupply ?? 0).toBe(0);
    expect(r.supplyDeferred).toBeGreaterThan(0);
  });

  it('공급처 검색이 실패하면 판단 보류(키워드를 버리지 않음), 검색 한도를 넘으면 다음 회차로', async () => {
    await setupDiscovery();
    await h.ctx.settings.update({ discovery: { supplyCheck: { enabled: true, minMatches: 3, perRun: 40 } } });
    h.manualSource.search = h.apiSource.search = async () => {
      throw new Error('timeout');
    };
    await discoverKeywords(h.ctx);
    const names = (await h.ctx.db.selectFrom('keywords').select('keyword').execute()).map((x) => x.keyword);
    expect(names).toContain('서랍정리함');
    expect(names).toContain('수납장');
  });
});
