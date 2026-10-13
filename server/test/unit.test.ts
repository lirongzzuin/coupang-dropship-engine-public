import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAuthorization, signedDate } from '../src/adapters/coupang/hmac.js';
import { money } from '../src/adapters/coupang/client.js';
import { parseTierPrice } from '../src/adapters/domeggook/source.js';
import { SourceRegistry } from '../src/adapters/registry.js';
import { MockSource } from '../src/adapters/fake/mockSource.js';
import { loadEnv, isLive } from '../src/config/env.js';
import { defaultSettings, mergeSettings } from '../src/config/settings.js';
import { base32Encode, generateTotpSecret, hashPassword, PiiCipher, totpAt, verifyPassword, verifyTotp } from '../src/lib/crypto.js';
import { maskAddress, maskName, maskPhone } from '../src/lib/logger.js';
import { kstDate, kstIsoMinute, roundUp } from '../src/lib/util.js';
import { classify } from '../src/modules/cs/service.js';
import { buildNotices } from '../src/modules/listing/payload.js';
import { buildDetailHtml, buildTags, findBannedTerms, sanitizeTitle } from '../src/modules/listing/text.js';
import { parseCsv } from '../src/modules/marketdata/csvImport.js';
import { resolveCourierCode } from '../src/modules/orders/service.js';
import { canTransition, ORDER_STATUSES } from '../src/modules/orders/stateMachine.js';
import { computeProfit, feeRateFor, guardPriceChange, targetPrice } from '../src/modules/pricing/pricing.js';
import { evaluateGates, scoreCandidate, trendSlope } from '../src/modules/selection/scoring.js';
import { TEST_ENV_BASE } from './helpers.js';

const S0 = () => mergeSettings(defaultSettings(), { fees: { monthlyServiceFee: 0 } });

describe('crypto', () => {
  it('PII 암호화 왕복, 매번 다른 암호문', () => {
    const c = new PiiCipher('b'.repeat(64));
    const a = c.encrypt('홍길동')!;
    const b = c.encrypt('홍길동')!;
    expect(a).not.toBe(b);
    expect(c.decrypt(a)).toBe('홍길동');
    expect(c.encrypt('')).toBeNull();
    expect(() => new PiiCipher('c'.repeat(64)).decrypt(a)).toThrow();
  });
  it('비밀번호 해시 검증', () => {
    const h = hashPassword('correct horse battery');
    expect(verifyPassword('correct horse battery', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });
  it('TOTP RFC 6238 테스트 벡터(SHA1, T=59 → 94287082)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpAt(secret, 59_000, 30, 8)).toBe('94287082');
    expect(totpAt(secret, 1111111109_000, 30, 8)).toBe('07081804');
    const s = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(s, totpAt(s, now), now)).toBe(true);
    expect(verifyTotp(s, totpAt(s, now - 30_000), now)).toBe(true);
    expect(verifyTotp(s, totpAt(s, now - 120_000), now)).toBe(false);
    expect(verifyTotp(s, 'abc', now)).toBe(false);
  });
  it('마스킹', () => {
    expect(maskName('홍길동')).toBe('홍*동');
    expect(maskName('김수')).toBe('김*');
    expect(maskPhone('010-1234-5678')).toBe('010-****-5678');
    expect(maskAddress('서울특별시 중구 세종대로 110')).toBe('서울특별시 중구 ***');
  });
});

describe('쿠팡 HMAC', () => {
  it('signed-date 형식 yyMMddTHHmmssZ (UTC)', () => {
    expect(signedDate(new Date('2018-08-09T09:30:15.123Z'))).toBe('180809T093015Z');
  });
  it('서명 = HMAC-SHA256(datetime+method+path+query) hex', () => {
    const now = new Date('2026-10-13T01:02:03Z');
    const auth = buildAuthorization({ method: 'get', path: '/v2/x', query: 'a=1&b=2', accessKey: 'AK', secretKey: 'SK', now });
    const expected = createHmac('sha256', 'SK').update('261013T010203ZGET/v2/xa=1&b=2').digest('hex');
    expect(auth).toBe(`CEA algorithm=HmacSHA256, access-key=AK, signed-date=261013T010203Z, signature=${expected}`);
  });
  it('금액 객체 변환', () => {
    expect(money({ units: 15000, nanos: 0 })).toBe(15000);
    expect(money(1234)).toBe(1234);
    expect(money(null)).toBe(0);
  });
});

describe('env / settings', () => {
  it('기본값은 DRY_RUN=true, 모든 LIVE 차단', () => {
    const env = loadEnv(TEST_ENV_BASE);
    expect(env.DRY_RUN).toBe(true);
    expect(isLive(env, 'LIVE_ORDERING')).toBe(false);
    const env2 = loadEnv({ ...TEST_ENV_BASE, LIVE_ORDERING: 'true' });
    expect(isLive(env2, 'LIVE_ORDERING')).toBe(false); // DRY_RUN 이 우선
    const env3 = loadEnv({ ...TEST_ENV_BASE, DRY_RUN: 'false', LIVE_ORDERING: 'true' });
    expect(isLive(env3, 'LIVE_ORDERING')).toBe(true);
    expect(isLive(env3, 'LIVE_LISTING')).toBe(false);
  });
  it('쿠팡 어댑터는 키 필수', () => {
    expect(() => loadEnv({ ...TEST_ENV_BASE, MARKET_ADAPTER: 'coupang' })).toThrow(/COUPANG/);
    expect(() => loadEnv({ ...TEST_ENV_BASE, PII_KEY: 'short' })).toThrow();
  });
  it('설정 깊은 병합 + 검증', () => {
    const s = mergeSettings(defaultSettings(), { pricing: { minProfitKrw: 3000 } });
    expect(s.pricing.minProfitKrw).toBe(3000);
    expect(s.pricing.minMarginRate).toBe(0.1);
    expect(() => mergeSettings(defaultSettings(), { pricing: { minProfitKrw: 'x' } })).toThrow();
    expect(s.orders.mode).toBe('auto');
    expect(s.selection.mode).toBe('auto');
  });
});

describe('pricing — feasibility.md 표와 일치', () => {
  // 표 조건: 배송비 3,000, 반품충당 3%, 월정액 0, 매입세액 공제
  const base = (over: object = {}) => mergeSettings(S0(), { pricing: { minProfitKrw: 0, minMarginRate: 0, ...over } });
  const tp = (s: ReturnType<typeof S0>, cost: number, cat: string) => targetPrice(s, { cost, shipping: 3000, categoryPath: cat, inputVatDeductible: true }).price;
  it('손익분기 판매가', () => {
    expect(tp(base(), 5000, '생활용품')).toBe(9100);
    expect(tp(base(), 10000, '가구/홈인테리어')).toBe(15400);
    expect(tp(base(), 20000, '뷰티')).toBe(26800);
    expect(tp(base(), 50000, '주방용품')).toBe(62500);
  });
  it('순이익 2,000원 / 순이익률 15%', () => {
    expect(tp(base({ minProfitKrw: 2000 }), 10000, '가구/홈인테리어')).toBe(18000);
    expect(tp(base({ minMarginRate: 0.15 }), 10000, '가구/홈인테리어')).toBe(19100);
    expect(tp(base({ minProfitKrw: 2000 }), 30000, '생활용품')).toBe(40000);
  });
  it('경계값: 하한가에서는 기준 충족, 한 단위 아래는 미달', () => {
    const s = mergeSettings(S0(), { pricing: { minProfitKrw: 2000, minMarginRate: 0 } });
    const r = targetPrice(s, { cost: 10000, shipping: 3000, categoryPath: '가구/홈인테리어', inputVatDeductible: true });
    expect(r.breakdown!.profit).toBeGreaterThanOrEqual(2000);
    const below = computeProfit(s, r.floor - 100, { cost: 10000, shipping: 3000, categoryPath: '가구/홈인테리어', inputVatDeductible: true });
    expect(below.profit).toBeLessThan(2000);
  });
  it('매입세액 공제 불가면 판매가가 더 높아짐', () => {
    const s = base({ minProfitKrw: 2000 });
    const a = targetPrice(s, { cost: 10000, shipping: 3000, inputVatDeductible: true }).price;
    const b = targetPrice(s, { cost: 10000, shipping: 3000, inputVatDeductible: false }).price;
    expect(b).toBeGreaterThan(a);
  });
  it('최저판매준수가가 하한보다 높으면 준수가 적용', () => {
    const r = targetPrice(base(), { cost: 5000, shipping: 3000, minResalePrice: 12345 });
    expect(r.price).toBe(12400);
  });
  it('수수료+충당금이 너무 크면 불가', () => {
    const s = mergeSettings(S0(), { fees: { defaultRate: 0.5 }, pricing: { returnReserveRate: 0.45 } });
    expect(targetPrice(s, { cost: 1000, shipping: 0 }).feasible).toBe(false);
  });
  it('카테고리 수수료: 가장 긴 접두 우선, 없으면 기본', () => {
    const s = mergeSettings(S0(), { fees: { categoryRates: [{ match: '생활용품', rate: 0.078 }, { match: '생활용품>공구', rate: 0.108 }] } });
    expect(feeRateFor(s, '생활용품>수납')).toBe(0.078);
    expect(feeRateFor(s, '생활용품>공구>드라이버')).toBe(0.108);
    expect(feeRateFor(s, '알수없음')).toBe(s.fees.defaultRate);
    expect(feeRateFor(s, null)).toBe(s.fees.defaultRate);
  });
  it('월 고정비 배분이 이익에서 차감', () => {
    const s = mergeSettings(defaultSettings(), { fees: { monthlyServiceFee: 55000, expectedMonthlyOrders: 100 } });
    const a = computeProfit(s, 20000, { cost: 10000, shipping: 3000 }).profit;
    const b = computeProfit(S0(), 20000, { cost: 10000, shipping: 3000 }).profit;
    expect(b - a).toBe(550);
  });
  it('가격 변경 가드', () => {
    const s = S0();
    expect(guardPriceChange(s, { current: 20000, desired: 20000, floor: 15000, changesToday: 0 }).price).toBeNull();
    expect(guardPriceChange(s, { current: 20000, desired: 25000, floor: 15000, changesToday: 2 }).reason).toBe('daily-limit');
    expect(guardPriceChange(s, { current: 20000, desired: 50000, floor: 15000, changesToday: 0 }).price).toBe(30000); // +50% 상한
    expect(guardPriceChange(s, { current: 20000, desired: 10000, floor: 15000, changesToday: 0 }).price).toBe(16000); // -20% 상한
    expect(guardPriceChange(s, { current: 20000, desired: 10000, floor: 18000, changesToday: 0 }).price).toBe(18000); // 하한 엄수
    expect(guardPriceChange(s, { current: 20000, desired: 21050, floor: 15000, changesToday: 0 }).price).toBe(21100);
  });
});

describe('listing text', () => {
  const banned = defaultSettings().listing.bannedTerms;
  it('금지 문구 제거·정리', () => {
    const t = sanitizeTitle('[무료배송] 국내발송 대용량 수납 정리함 최저가 특가!!', banned, 100);
    expect(t).toBe('대용량 수납 정리함');
    expect(findBannedTerms(t, banned)).toEqual([]);
    expect(findBannedTerms('오늘 무료 배송 상품', banned)).toEqual(['무료배송']);
  });
  it('길이 제한(글자 기준)', () => {
    expect([...sanitizeTitle('가'.repeat(150), banned, 100)].length).toBe(100);
  });
  it('검색태그 중복 제거·20자·금지어 제외', () => {
    const tags = buildTags('대용량 수납 정리함 수납', '수납함', banned, 20);
    expect(tags).toEqual(['수납함', '대용량', '수납', '정리함']);
    expect(buildTags('특가 상품', '특가', banned, 20)).toEqual(['상품']);
  });
  it('상세페이지: 재사용 불가면 원본 HTML 미포함, 스크립트 제거', () => {
    const src = '<p>원본</p><script>alert(1)</script><img src="a.jpg" onerror="x()">';
    expect(buildDetailHtml({ title: 't', images: ['https://i/1.jpg'], facts: [], sourceHtml: src, reuseAllowed: false })).not.toContain('원본');
    const ok = buildDetailHtml({ title: 't', images: [], facts: [{ name: '원산지', value: '한국' }], sourceHtml: src, reuseAllowed: true });
    expect(ok).toContain('원본');
    expect(ok).not.toContain('<script>');
    expect(ok).not.toContain('onerror');
    expect(ok).toContain('원산지');
  });
  it('고시정보 매핑: 공급처 값 → 기본값 → 상세페이지 참조', () => {
    const meta = { code: '1', requiredAttributes: [], notices: [{ noticeCategoryName: '기타 재화', details: [{ name: '품명 및 모델명', required: true }, { name: '제조국(원산지)', required: true }, { name: '소비자상담 관련 전화번호', required: true }, { name: '기타', required: false }] }] };
    const n = buildNotices(meta, { notice: { items: [{ name: '품명 및 모델명', value: '정리함 A1' }] }, origin: '중국' } as any, '1588-0000');
    expect(n.map((x) => x.content)).toEqual(['정리함 A1', '중국', '1588-0000', '상세페이지 참조']);
  });
});

describe('selection scoring', () => {
  const s = mergeSettings(S0(), { selection: { minSupplyPrice: 5000, minStock: 5 } });
  const d = { sourceItemId: '1', title: '수납 정리함', url: '', price: 10000, shippingFee: 3000, status: 'active', stock: 100, imageReuseAllowed: true, images: [], taxInvoice: true, categoryPath: '생활용품' } as any;
  const tp = targetPrice(s, { cost: 10000, shipping: 3000, categoryPath: '생활용품' });
  it('시장 최저가보다 비싸면 탈락, 싸면 통과', () => {
    const fail = evaluateGates(s, d, tp, { naverLowest: tp.price - 100 }, { apiOrder: true });
    expect(fail.find((g) => g.name === 'competitive')!.pass).toBe(false);
    const ok = evaluateGates(s, d, tp, { naverLowest: tp.price + 5000 }, { apiOrder: true });
    expect(ok.filter((g) => g.hard).every((g) => g.pass)).toBe(true);
  });
  it('상표·금지 카테고리·KC 미인증 탈락', () => {
    const g1 = evaluateGates(s, { ...d, title: '나이키 가방' }, tp, { naverLowest: 99999 }, { apiOrder: true });
    expect(g1.find((g) => g.name === 'trademark')!.pass).toBe(false);
    const g2 = evaluateGates(s, { ...d, title: 'USB 충전 선풍기', kc: { certified: false, exempt: false } }, tp, { naverLowest: 99999 }, { apiOrder: true });
    expect(g2.find((g) => g.name === 'kc')!.pass).toBe(false);
    const g3 = evaluateGates(s, { ...d, title: 'USB 충전 선풍기', kc: { certified: true, exempt: false, certNo: 'XU1' } }, tp, { naverLowest: 99999 }, { apiOrder: true });
    expect(g3.find((g) => g.name === 'kc')!.pass).toBe(true);
    const g4 = evaluateGates(s, { ...d, title: '건강기능식품 비타민' }, tp, { naverLowest: 99999 }, { apiOrder: true });
    expect(g4.find((g) => g.name === 'category')!.pass).toBe(false);
  });
  it('시장가 미상: requireMarketPrice 설정 따름', () => {
    expect(evaluateGates(s, d, tp, {}, { apiOrder: true }).find((g) => g.name === 'competitive')!.pass).toBe(false);
    const s2 = mergeSettings(s, { selection: { requireMarketPrice: false } });
    expect(evaluateGates(s2, d, tp, {}, { apiOrder: true }).find((g) => g.name === 'competitive')!.pass).toBe(true);
  });
  it('점수: 0~1, 자동발주 가능 소스가 더 높음, 추세 기울기', () => {
    const a = scoreCandidate(s, d, tp, { naverLowest: 30000, naverCount: 500, searchVolume: 20000 }, { apiOrder: true });
    const b = scoreCandidate(s, d, tp, { naverLowest: 30000, naverCount: 500, searchVolume: 20000 }, { apiOrder: false });
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.score).toBeLessThanOrEqual(1);
    expect(trendSlope([10, 10, 10, 10, 20, 20, 20, 20], 4)).toBe(1);
    expect(trendSlope([20, 20, 20, 20, 10, 10, 10, 10], 4)).toBe(-0.5);
    expect(trendSlope([1, 2], 4)).toBeUndefined();
  });
});

describe('orders 도메인', () => {
  it('상태머신: 정상 흐름 허용, 역행 차단, 종료 상태 고정', () => {
    expect(canTransition('NEW', 'PURCHASED')).toBe(true);
    expect(canTransition('PURCHASED', 'TRACKING_UPLOADED')).toBe(true);
    expect(canTransition('DELIVERED', 'NEW')).toBe(false);
    expect(canTransition('CANCELLED', 'NEW')).toBe(false);
    for (const st of ORDER_STATUSES) expect(canTransition(st, st)).toBe(true);
  });
  it('택배사 이름 → 쿠팡 코드', () => {
    const a = defaultSettings().orders.courierAliases;
    expect(resolveCourierCode(a, 'CJ대한통운')).toBe('CJGLS');
    expect(resolveCourierCode(a, 'CJ 대한통운')).toBe('CJGLS');
    expect(resolveCourierCode(a, '롯데택배')).toBe('HYUNDAI');
    expect(resolveCourierCode(a, '로젠')).toBe('KGB');
    expect(resolveCourierCode(a, 'EPOST')).toBe('EPOST');
    expect(resolveCourierCode(a, '없는택배')).toBeNull();
  });
  it('CS 분류: 배송문의 자동, 불만·환불은 사람', () => {
    const t = defaultSettings().cs.templates;
    expect(classify('언제 배송되나요?', t)?.name).toBe('delivery');
    expect(classify('배송 왔는데 파손됐어요 환불해주세요', t)).toBeNull();
    expect(classify('색상 문의', t)).toBeNull();
  });
});

describe('기타', () => {
  it('KST 날짜·쿠팡 조회 시각 형식', () => {
    const d = new Date('2026-10-13T16:30:00Z');
    expect(kstDate(d)).toBe('2026-10-14');
    expect(kstIsoMinute(d)).toBe('2026-10-14T01:30+09:00');
    expect(roundUp(15301, 100)).toBe(15400);
  });
  it('CSV 파싱(따옴표·BOM·탭)', () => {
    expect(parseCsv('﻿키워드,판매량\n"수납, 정리",1,200\n')).toEqual([['키워드', '판매량'], ['수납, 정리', '1', '200']]);
    expect(parseCsv('a\tb\r\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('도매꾹 수량별 단가 파싱', () => {
    expect(parseTierPrice('1+3800|20+3500|50+3300')).toBe(3800);
    expect(parseTierPrice(4200)).toBe(4200);
    expect(parseTierPrice('5000')).toBe(5000);
  });
  it('쿠팡을 공급처로 등록 불가(재판매 금지)', () => {
    expect(() => new SourceRegistry().register(new MockSource('coupang'))).toThrow(/금지/);
  });
});
