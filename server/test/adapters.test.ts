import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoupangClient } from '../src/adapters/coupang/client.js';
import { CoupangMarket } from '../src/adapters/coupang/market.js';
import { DomeggookSource } from '../src/adapters/domeggook/source.js';
import { NaverClient } from '../src/adapters/naver/client.js';
import { ElevenstSearchClient, parseElevenstSearch } from '../src/adapters/elevenst/search.js';
import iconv from 'iconv-lite';
import { OwnerclanSource } from '../src/adapters/ownerclan/source.js';
import { TelegramNotifier } from '../src/adapters/telegram/notifier.js';
import { CoupangPartnersClient } from '../src/adapters/coupang/partners.js';
import { GoogleTrendsClient, parseGoogleJson } from '../src/adapters/google/trends.js';
import { createLogger } from '../src/lib/logger.js';

const log = createLogger('silent');

// ── 쿠팡: 실제 HTTP 서버로 서명·경로·재시도 검증 ─────────────────────
describe('CoupangMarket (로컬 HTTP 목 서버)', () => {
  let server: Server;
  let base = '';
  const seen: Array<{ method: string; path: string; query: string; body: any; auth: string }> = [];
  let fail429 = 0;

  const verify = (req: IncomingMessage, path: string, query: string): boolean => {
    const auth = String(req.headers.authorization ?? '');
    const m = auth.match(/signed-date=(\w+), signature=(\w+)/);
    if (!m) return false;
    const expect = createHmac('sha256', 'SECRET').update(`${m[1]}${req.method}${path}${query}`).digest('hex');
    return expect === m[2] && auth.includes('access-key=ACCESS');
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const url = new URL(req.url!, 'http://x');
        const query = url.search.replace(/^\?/, '');
        seen.push({ method: req.method!, path: url.pathname, query, body: raw ? JSON.parse(raw) : undefined, auth: String(req.headers.authorization) });
        if (!verify(req, url.pathname, query)) {
          res.writeHead(401).end(JSON.stringify({ message: 'Invalid signature' }));
          return;
        }
        const send = (code: number, obj: unknown, headers: Record<string, string> = {}) => res.writeHead(code, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(obj));
        if (fail429 > 0) {
          fail429--;
          return send(429, { message: 'Too many requests' });
        }
        const p = url.pathname;
        if (p.endsWith('/ordersheets') && req.method === 'GET') {
          return send(200, { code: 200, data: [{ shipmentBoxId: 111, orderId: 222, orderedAt: '2026-10-13T10:00:00', status: 'ACCEPT', receiver: { name: '홍길동', safeNumber: '0503-1111-2222', addr1: '서울', addr2: '1층', postCode: '01234' }, parcelPrintMessage: '문앞', orderItems: [{ vendorItemId: 333, vendorItemName: '정리함', shippingCount: 2, orderPrice: { units: 60000, nanos: 0 }, discountPrice: { units: 0, nanos: 0 }, estimatedShippingDate: '2026-10-14' }] }], nextToken: '' }, { 'x-cag-warnings': 'near threshold' });
        }
        if (p.endsWith('/acknowledgement')) return send(200, { code: 200, data: { responseCode: 0, responseList: [{ shipmentBoxId: 111, succeed: true, resultCode: 'OK', retryRequired: false, resultMessage: 'OK' }] } });
        if (p.endsWith('/orders/invoices')) return send(200, { code: 200, data: { responseCode: 1, responseList: [{ shipmentBoxId: 111, succeed: false, resultCode: 'INVALID_INVOICE_NUMBER', retryRequired: true, resultMessage: '송장번호 형식 오류' }] } });
        if (p.endsWith('/categorization/predict')) return send(200, { code: 200, data: { autoCategorizationPredictionResultType: 'SUCCESS', predictedCategoryId: '63950', predictedCategoryName: '수납' } });
        if (p.includes('/category-related-metas/')) return send(200, { code: 'SUCCESS', data: { attributes: [{ attributeTypeName: '수량', required: 'MANDATORY' }], noticeCategories: [{ noticeCategoryName: '기타 재화', noticeCategoryDetailNames: [{ noticeCategoryDetailName: '품명 및 모델명', required: 'MANDATORY' }] }] } });
        if (p.endsWith('/seller-products') && req.method === 'POST') return send(200, { code: 'SUCCESS', message: '', data: 5555 });
        if (p.endsWith('/seller-products/5555')) return send(200, { code: 'SUCCESS', data: { statusName: '승인완료', items: [{ vendorItemId: 7777 }] } });
        if (p.includes('/prices/')) return send(200, { code: 'SUCCESS', message: '변경 완료' });
        if (p.endsWith('/sales/stop')) return send(400, { code: 'ERROR', message: '삭제된 상품' });
        if (p.endsWith('/revenue-history')) return send(200, { code: 200, hasNext: false, nextToken: '', data: [{ orderId: 222, saleType: 'SALE', recognitionDate: '2026-10-20', items: [{ vendorItemId: 333, saleAmount: 60000, serviceFee: 6000, serviceFeeVat: 600, settlementAmount: 53400 }], deliveryFee: { settlementAmount: 0 } }] });
        if (p.endsWith('/returnRequests')) return send(200, { code: 200, data: url.searchParams.get('cancelType') === 'CANCEL' ? [] : [{ receiptId: 9, orderId: 222, receiptType: 'RETURN', receiptStatus: 'RETURNS_UNCHECKED', createdAt: '2026-10-13T11:00:00', cancelReasonCategory1: '단순변심', cancelReason: '필요없음', returnItems: [{ vendorItemId: 333 }] }] });
        if (p.endsWith('/onlineInquiries')) return send(200, { code: 200, data: { content: [{ inquiryId: 1, vendorItemId: 333, content: '배송 언제?', inquiryAt: '2026-10-13T09:00:00+09:00', commentDtoList: [] }], pagination: { currentPage: 1, totalPages: 1 } } });
        if (p.endsWith('/replies')) return send(200, { code: 200, message: 'OK' });
        send(404, { message: 'nf' });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const make = () => new CoupangMarket(new CoupangClient({ baseUrl: base, vendorId: 'A001', accessKey: 'ACCESS', secretKey: 'SECRET', requestsPerSecond: 50, logger: log, throttlePenaltyMs: 50, warningPenaltyMs: 10, retryBaseMs: 10 }), async () => 'wingid');

  it('발주서 조회: 서명 검증 통과, 24h 구간 분할, 금액·수취인 파싱', async () => {
    const m = make();
    const lines = await m.listOrders(new Date('2026-10-12T00:00:00Z'), new Date('2026-10-13T12:00:00Z'), 'ACCEPT');
    const calls = seen.filter((s) => s.path.endsWith('/ordersheets'));
    expect(calls.length).toBe(2); // 36시간 → 2구간
    expect(calls[0]!.query).toContain('searchType=timeFrame');
    expect(decodeURIComponent(calls[0]!.query)).toContain('createdAtFrom=2026-10-12T09:00+09:00');
    expect(lines[0]).toMatchObject({ shipmentBoxId: '111', marketOrderId: '222', vendorItemId: '333', qty: 2, paidAmount: 60000, shipBy: '2026-10-14' });
    expect(lines[0]!.receiver).toMatchObject({ name: '홍길동', phone: '0503-1111-2222', zip: '01234' });
  });

  it('429 → 백오프 후 재시도 성공', async () => {
    fail429 = 1;
    const m = make();
    const r = await m.acknowledge(['111']);
    expect(r['111']!.ok).toBe(true);
    const ack = seen.filter((s) => s.path.endsWith('/acknowledgement'));
    expect(ack.length).toBe(2);
    expect(ack[1]!.body).toEqual({ vendorId: 'A001', shipmentBoxIds: [111] });
  }, 20000);

  it('송장 업로드: 항목별 retryRequired 전달', async () => {
    const r = await make().uploadInvoice({ shipmentBoxId: '111', marketOrderId: '222', vendorItemId: '333', courierCode: 'CJGLS', trackingNo: '1' });
    expect(r).toEqual({ ok: false, retryable: true, message: '송장번호 형식 오류' });
    const body = seen.filter((s) => s.path.endsWith('/orders/invoices')).at(-1)!.body;
    expect(body.orderSheetInvoiceApplyDtos[0]).toMatchObject({ shipmentBoxId: 111, orderId: 222, vendorItemId: 333, deliveryCompanyCode: 'CJGLS', splitShipping: false });
  });

  it('상품: 카테고리 추천·메타·생성·상태·가격(10원 단위)·중지 실패', async () => {
    const m = make();
    expect(await m.predictCategory('정리함')).toEqual({ code: '63950', name: '수납' });
    const meta = await m.getCategoryMeta('63950');
    expect(meta.requiredAttributes).toEqual(['수량']);
    expect(meta.notices[0]!.details[0]).toEqual({ name: '품명 및 모델명', required: true });
    expect(await m.createProduct({ a: 1 })).toEqual({ sellerProductId: '5555' });
    expect(await m.getProductStatus('5555')).toMatchObject({ status: 'APPROVED', vendorItemIds: ['7777'] });
    expect((await m.updatePrice('7777', 12345)).ok).toBe(true);
    expect(seen.some((s) => s.path.endsWith('/prices/12350') && s.query === 'forceSalePriceUpdate=false')).toBe(true);
    expect((await m.stopSale('7777')).ok).toBe(false);
  });

  it('정산·반품·문의', async () => {
    const m = make();
    const rev = await m.listRevenue('2026-10-01', '2026-10-20');
    expect(rev[0]).toMatchObject({ marketOrderId: '222', vendorItemId: '333', saleType: 'SALE', serviceFee: 6000, settlementAmount: 53400 });
    const claims = await m.listClaims(new Date('2026-10-12T00:00:00Z'), new Date('2026-10-13T12:00:00Z'));
    expect(claims[0]).toMatchObject({ type: 'RETURN', marketOrderId: '222', vendorItemId: '333' });
    const inq = await m.listInquiries(new Date('2026-10-10T00:00:00Z'), new Date('2026-10-13T00:00:00Z'));
    expect(inq[0]).toMatchObject({ inquiryId: '1', kind: 'product', answered: false });
    expect((await m.replyInquiry({ inquiryId: '1', kind: 'product' }, '안녕하세요')).ok).toBe(true);
    expect(seen.at(-1)!.body).toEqual({ content: '안녕하세요', vendorId: 'A001', replyBy: 'wingid' });
  });

  it('잘못된 서명은 401', async () => {
    const bad = new CoupangMarket(new CoupangClient({ baseUrl: base, vendorId: 'A001', accessKey: 'ACCESS', secretKey: 'WRONG', requestsPerSecond: 50, logger: log, retryBaseMs: 10 }), async () => '');
    await expect(bad.predictCategory('x')).rejects.toThrow(/401/);
  });
});

// ── 공급처 어댑터: fetch 목으로 요청·파싱 검증 ───────────────────────
type Call = { url: string; init?: RequestInit };
const jsonRes = (obj: unknown, status = 200) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

describe('OwnerclanSource', () => {
  const calls: Call[] = [];
  let createdOrders = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/auth')) return new Response('jwt-token-abc', { status: 200 });
    const body = JSON.parse(String(init?.body));
    const q: string = body.query;
    if (q.includes('allItems')) return jsonRes({ data: { allItems: { edges: [{ node: { key: 'W123', name: '정리함', price: 12000, shippingFee: 3000, shippingType: 'inAdvance', images: ['https://img/1.jpg'] } }] } } });
    if (q.includes('item(key')) return jsonRes({ data: { item: { key: 'W123', name: '정리함', model: 'M1', production: '오너제조', origin: '중국', price: 12000, pricePolicy: 'fixed', fixedPrice: 19900, category: { fullName: '생활용품>수납' }, content: '<p>상세</p>', shippingFee: 3000, shippingType: 'inAdvance', images: ['https://img/1.jpg', 'https://img/2.jpg'], status: 'available', options: [{ optionAttributes: [], price: 12000, quantity: 37 }], guaranteedShippingPeriod: 2, openmarketSellable: true } } });
    if (q.includes('allOrders')) return jsonRes({ data: { allOrders: { edges: createdOrders ? [{ node: { key: 'OC1', status: 'paid', products: [{ price: 12000, quantity: 1 }], shippingInfo: { shippingFee: 3000 } } }] : [] } } });
    if (q.includes('simulateCreateOrder')) return jsonRes({ data: { simulateCreateOrder: [{ itemAmounts: [{ itemKey: 'W123', amount: 12000 }], shippingAmount: 3000, extraShippingFeeExists: false }] } });
    if (q.includes('createOrder')) {
      createdOrders++;
      return jsonRes({ data: { createOrder: [{ key: 'OC1', status: 'paid' }] } });
    }
    if (q.includes('order(key')) return jsonRes({ data: { order: { status: 'shipped', products: [{ trackingNumber: '6123-4567-8901', shippingCompanyName: 'CJ대한통운' }] } } });
    return jsonRes({ errors: [{ message: 'unknown' }] });
  }) as unknown as typeof fetch;
  const oc = new OwnerclanSource({ username: 'u', password: 'p', logger: log, fetchImpl, requestsPerSecond: 100 });

  it('JWT 인증 후 Bearer 로 GraphQL 호출, 검색·상세 파싱', async () => {
    const r = await oc.search('정리함');
    expect(r[0]).toMatchObject({ sourceItemId: 'W123', price: 12000, shippingFee: 3000 });
    expect((calls.find((c) => c.url.includes('graphql'))!.init!.headers as Record<string, string>).Authorization).toBe('Bearer jwt-token-abc');
    const d = (await oc.getProduct('W123'))!;
    expect(d).toMatchObject({ status: 'active', stock: 37, minResalePrice: 19900, prepDays: 2, imageReuseAllowed: true, categoryPath: '생활용품>수납', origin: '중국' });
    expect(d.images).toHaveLength(2);
  });

  it('발주: 시뮬레이션 → 생성, 멱등키로 재호출 시 재생성 안 함', async () => {
    const req = { idempotencyKey: 'cp-1-2', sourceItemId: 'W123', qty: 1, receiver: { name: '홍', phone: '010', addr1: 'a', addr2: 'b', zip: '1' } };
    const r1 = await oc.placeOrder(req);
    expect(r1).toEqual({ sourceOrderId: 'OC1', cost: 12000, shippingCost: 3000, needsPayment: false });
    const create = calls.find((c) => String(c.init?.body).includes('createOrder(input'))!;
    const vars = JSON.parse(String(create.init!.body)).variables;
    expect(vars.input.note).toBe('cp-1-2');
    // 실 스키마: 보내는 사람 필수, 옵션 없으면 빈 배열, 시뮬레이션은 mutation
    expect(vars.input.sender).toEqual({ name: '홍', phoneNumber: '010' });
    expect(vars.input.products[0].optionAttributes).toEqual([]);
    expect(String(calls.find((c) => String(c.init?.body).includes('simulateCreateOrder'))!.init!.body)).toContain('mutation(');
    expect(vars.sim[0].shippingAmount).toBe(3000);
    const r2 = await oc.placeOrder(req);
    expect(r2.sourceOrderId).toBe('OC1');
    expect(createdOrders).toBe(1);
  });

  it('송장 조회: 숫자만 추출', async () => {
    expect(await oc.getTracking('OC1')).toEqual({ courierName: 'CJ대한통운', trackingNo: '612345678901' });
  });
});

describe('OwnerclanSource 계정 유형·권한', () => {
  it('seller 아이디 없음이면 vendor 로 재시도, API 미승인은 명확한 안내', async () => {
    const types: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes('/auth')) {
        const b = JSON.parse(String(init?.body));
        types.push(b.userType);
        return b.userType === 'vendor' ? new Response('jwt', { status: 200 }) : new Response('{"name":"IDNotFound","message":"존재하지 않는 아이디입니다."}', { status: 401 });
      }
      return jsonRes({ errors: [{ message: 'Access denied', detail: 'Not authorized to use API. Please contact administrator.' }], data: null });
    }) as unknown as typeof fetch;
    const oc = new OwnerclanSource({ username: 'u', password: 'p', logger: log, fetchImpl, requestsPerSecond: 100 });
    await expect(oc.search('x')).rejects.toThrow(/API 사용 권한 없음/);
    expect(types).toEqual(['seller', 'vendor']);
  });
});

describe('DomeggookSource 배송비', () => {
  it('수량별비례(tbl)는 fee 필드가 없어도 배송비·상자당 수량을 읽음, 무료배송은 0', async () => {
    const view = (deli: any) => (async () => jsonRes({ domeggook: { basis: { title: 't', status: '판매중' }, price: { supply: 5000 }, qty: { inventory: 10 }, deli, thumb: {}, desc: {}, seller: {}, category: {}, detail: {} } })) as unknown as typeof fetch;
    const tbl = await new DomeggookSource({ apiKey: 'K', market: 'supply', logger: log, fetchImpl: view({ pay: '선결제', supply: { type: '수량별비례', tbl: '10+3000|10+3000' }, merge: { enable: 'y' } }) }).getProduct('1');
    expect(tbl).toMatchObject({ shippingFee: 3000, maxPerBox: 10, shippingPerUnit: false });
    const one = await new DomeggookSource({ apiKey: 'K', market: 'supply', logger: log, fetchImpl: view({ pay: '선결제', supply: { type: '수량별비례', tbl: '1+4500|1+4500' }, merge: { enable: 'n' } }) }).getProduct('1');
    expect(one).toMatchObject({ shippingFee: 4500, shippingPerUnit: true });
    const free = await new DomeggookSource({ apiKey: 'K', market: 'supply', logger: log, fetchImpl: view({ pay: '무료배송', supply: null, merge: { enable: 'y' } }) }).getProduct('1');
    expect(free).toMatchObject({ shippingFee: 0, maxPerBox: null });
  });
});

describe('DomeggookSource', () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    if (u.searchParams.get('mode') === 'getItemList') return jsonRes({ domeggook: { header: { numberOfItems: 2 }, list: { item: [{ no: 101, title: '정리함', price: 9000, thumb: 'https://t/1.jpg', url: 'https://domeggook.com/101', deli: { who: 'P', fee: 3000 } }, { no: 102, title: '성인용', price: 5000, adultOnly: true, deli: { who: 'S' } }] } } });
    return jsonRes({ domeggook: { basis: { title: '정리함 대형', status: '판매중' }, price: { dome: 10000, supply: '1+9500|10+9000', resale: { minumum: 15000 } }, qty: { inventory: 80 }, deli: { pay: '선결제', dome: { fee: 3000 }, supply: { fee: 2500 }, periodDeli: 1 }, thumb: { original: 'https://t/o.jpg', large: 'https://t/l.jpg' }, desc: { license: { usable: true }, contents: { item: '<p>x</p>' } }, seller: { type: '일반과세자', score: { avg: 96 } }, category: { parents: { elem: [{ name: '생활' }] }, current: { name: '수납' } }, detail: { country: '중국', manufacturer: 'ABC', safetyCert: { cert: 'Y', no: 'XU0001', exem: 'N' }, infoDuty: { type: '기타 재화', item: [{ name: '품명 및 모델명', desc: '정리함 L' }] } } } });
  }) as unknown as typeof fetch;
  const dg = new DomeggookSource({ apiKey: 'KEY', market: 'supply', logger: log, fetchImpl });

  it('상품리스트: 도매매 시장·키워드 파라미터, 성인상품 제외', async () => {
    const r = await dg.search('정리함', { limit: 10, minPrice: 5000 });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ sourceItemId: '101', price: 9000, shippingFee: 3000 });
    const u = new URL(urls[0]!);
    expect(u.searchParams.get('market')).toBe('supply');
    expect(u.searchParams.get('kw')).toBe('정리함');
    expect(u.searchParams.get('mnp')).toBe('5000');
    expect(u.searchParams.get('aid')).toBe('KEY');
  });

  it('상품상세: 도매매 수량별 단가·배송비, 최저판매준수가, 이미지 사용허락, KC, 고시', async () => {
    const d = (await dg.getProduct('101'))!;
    expect(d).toMatchObject({ price: 9500, shippingFee: 2500, stock: 80, status: 'active', minResalePrice: 15000, imageReuseAllowed: true, taxInvoice: true, prepDays: 1, categoryPath: '생활>수납', sellerScore: 96 });
    expect(d.kc).toEqual({ certified: true, exempt: false, certNo: 'XU0001', certType: undefined });
    expect(d.notice!.items[0]).toEqual({ name: '품명 및 모델명', value: '정리함 L' });
  });
});

describe('Naver', () => {
  it('데이터랩·검색광고(HMAC) 요청 형식과 파싱', async () => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/v1/datalab/search')) return jsonRes({ results: [{ data: [{ ratio: 50 }, { ratio: 100 }] }] });
      if (url.includes('keywordstool')) return jsonRes({ keywordList: [{ relKeyword: '정리함', monthlyPcQcCnt: 1200, monthlyMobileQcCnt: '< 10', compIdx: '중간' }, { relKeyword: '서랍정리함', monthlyPcQcCnt: 3000, monthlyMobileQcCnt: 9000, compIdx: '낮음' }] });
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const n = new NaverClient({ clientId: 'id', clientSecret: 'sec', searchAd: { customerId: 'C', apiKey: 'K', secret: 'S' }, datalabEnabled: true, logger: log, fetchImpl });
    (n as any).adLimiter.setRate(1000);
    expect(await new NaverClient({ clientId: 'id', clientSecret: 'sec', logger: log, fetchImpl }).weeklyTrend('x', 12)).toBeNull(); // 데이터랩 권한 없으면 호출 안 함
    expect(await n.weeklyTrend('정리함', 12)).toEqual([50, 100]);
    expect(await n.monthlySearchVolume(['정리 함'])).toEqual({ 정리함: 1205 });
    const h = calls.at(-1)!.init!.headers as Record<string, string>;
    const sig = createHmac('sha256', 'S').update(`${h['X-Timestamp']}.GET./keywordstool`).digest('base64');
    expect(h['X-Signature']).toBe(sig);
    expect(calls.at(-1)!.url).toContain('hintKeywords=%EC%A0%95%EB%A6%AC%ED%95%A8');
    expect(await n.relatedKeywords('정리함')).toEqual([{ keyword: '서랍정리함', volume: 12000, competition: '낮음' }]);
    expect(await n.keywordStats(['정리함', 'a', 'b', 'c', 'd', 'e'])).toHaveLength(2);
    expect(decodeURIComponent(calls.at(-1)!.url)).toContain('hintKeywords=정리함,a,b,c,d&'); // 최대 5개
  });

  it('키워드도구 429 → 5분간 호출 중단(공식 가이드), 401 → 재발급 안내', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('{}', { status: calls === 1 ? 429 : 401 });
    }) as unknown as typeof fetch;
    const n = new NaverClient({ searchAd: { customerId: 'C', apiKey: 'K', secret: 'S' }, logger: log, fetchImpl });
    (n as any).adLimiter.setRate(1000);
    await expect(n.monthlySearchVolume(['a'])).rejects.toThrow(/429/);
    await expect(n.monthlySearchVolume(['a'])).rejects.toThrow(/5분/);
    expect(calls).toBe(1); // 차단 중엔 실제 호출 안 함
    (n as any).adBlockedUntil = 0;
    await expect(n.relatedKeywords('a')).rejects.toThrow(/광고주센터/);
  });

  it('키 미설정 시 신호 없음(null)', async () => {
    const n = new NaverClient({ logger: log });
    expect(await n.monthlySearchVolume(['x'])).toBeNull();
    expect(await n.keywordStats(['x'])).toBeNull();
  });
});

describe('11번가 상품검색(시장가)', () => {
  const xml = `<?xml version="1.0" encoding="EUC-KR"?><ProductSearchResponse><Products><TotalCount>1234</TotalCount>
    <Product><ProductCode>1</ProductCode><ProductName><![CDATA[캠핑 의자 <b>경량</b>]]></ProductName><ProductPrice>25000</ProductPrice><SalePrice>19900</SalePrice><SellerNick>A샵</SellerNick></Product>
    <Product><ProductCode>2</ProductCode><ProductName><![CDATA[릴렉스 체어]]></ProductName><ProductPrice>32000</ProductPrice><SalePrice></SalePrice><SellerNick>B샵</SellerNick></Product>
  </Products></ProductSearchResponse>`;
  it('EUC-KR 키워드 인코딩·XML 파싱·하루 캐시', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(new Uint8Array(iconv.encode(xml, 'euc-kr')));
    }) as unknown as typeof fetch;
    const store = new Map<string, unknown>();
    const c = new ElevenstSearchClient({ apiKey: 'K', logger: log, fetchImpl, cache: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) } });
    const r = (await c.shoppingSearch('캠핑'))!;
    expect(urls[0]).toContain('keyword=%C4%B7%C7%CE'); // EUC-KR
    expect(urls[0]).toContain('apiCode=ProductSearch');
    expect(r.total).toBe(1234);
    expect(r.source).toBe('11번가');
    expect(r.items.map((i) => [i.title, i.price, i.mall])).toEqual([['캠핑 의자 경량', 19900, 'A샵'], ['릴렉스 체어', 32000, 'B샵']]);
    await c.shoppingSearch('캠핑');
    expect(urls).toHaveLength(1);
  });
  it('오류 응답은 예외', () => {
    expect(() => parseElevenstSearch('<ErrorResponse><ErrorMessage>tMall.invalidOpenApiKey</ErrorMessage></ErrorResponse>')).toThrow(/invalidOpenApiKey/);
  });
});

describe('TelegramNotifier', () => {
  it('HTML 이스케이프·링크, 토큰 없으면 전송 안 함', async () => {
    let body: any;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return jsonRes({ ok: true });
    }) as unknown as typeof fetch;
    const t = new TelegramNotifier({ token: 'T', chatId: '1', logger: log, fetchImpl });
    expect(await t.send({ level: 'action', title: '<주문>', body: 'a & b', link: 'https://x/orders/1' })).toBe(true);
    expect(body.text).toContain('&lt;주문&gt;');
    expect(body.text).toContain('a &amp; b');
    expect(body.parse_mode).toBe('HTML');
    expect(await new TelegramNotifier({ logger: log }).send({ level: 'info', title: 'x', body: 'y' })).toBe(false);
  });
});

describe('구글 트렌드(보조)', () => {
  const series = (vals: number[]) => `)]}',\n${JSON.stringify({ default: { timelineData: vals.map((v) => ({ value: [v] })) } })}`;
  const make = (vals: number[], status = 200) => {
    const urls: string[] = [];
    const store = new Map<string, unknown>();
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (status !== 200) return new Response('', { status });
      if (url.includes('/trends/?geo')) return new Response('', { status: 200, headers: { 'set-cookie': 'NID=abc; Path=/' } });
      if (url.includes('/api/explore')) return new Response(`)]}'\n${JSON.stringify({ widgets: [{ id: 'TIMESERIES', token: 'T', request: { a: 1 } }] })}`);
      return new Response(series(vals));
    }) as unknown as typeof fetch;
    const c = new GoogleTrendsClient({ logger: log, fetchImpl, cache: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) } });
    (c as any).limiter.setRate(1000);
    return { c, urls };
  };
  it('쿠키 → explore → multiline 파싱, 하루 캐시', async () => {
    const { c, urls } = make([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(await c.weeklyTrend('정리함')).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(urls[1]).toContain('geo%22%3A%22KR');
    const n = urls.length;
    await c.weeklyTrend('정리함');
    expect(urls.length).toBe(n);
  });
  it('희소 데이터(0이 70% 이상)는 무시, 오류·429는 null', async () => {
    expect(await make([0, 0, 0, 0, 0, 0, 0, 100]).c.weeklyTrend('a')).toBeNull();
    expect(await make([1], 429).c.weeklyTrend('b')).toBeNull();
    expect(parseGoogleJson(")]}'\n{\"x\":1}")).toEqual({ x: 1 });
  });
});

describe('쿠팡 파트너스(선택)', () => {
  it('HMAC 서명·검색 파싱·시간당 한도·7일 캐시', async () => {
    const urls: Array<{ url: string; auth: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push({ url, auth: String((init!.headers as Record<string, string>).Authorization) });
      return jsonRes({ rCode: '0', data: { productData: [
        { productName: 'A', productPrice: 21000, isRocket: true, rank: 1 },
        { productName: 'B', productPrice: 18900, isRocket: false, rank: 2 },
        { productName: 'C', productPrice: 25000, isRocket: true, rank: 3 },
      ] } });
    }) as unknown as typeof fetch;
    const store = new Map<string, unknown>();
    const c = new CoupangPartnersClient({ accessKey: 'AK', secretKey: 'SK', logger: log, fetchImpl, maxPerHour: 2, cache: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) } });
    const v = await c.searchSignal('정리함');
    expect(v).toMatchObject({ lowest: 18900, median: 21000, count: 3 });
    expect(v!.rocketRatio).toBeCloseTo(2 / 3);
    expect(urls[0]!.url).toContain('/v2/providers/affiliate_open_api/apis/openapi/products/search?keyword=%EC%A0%95%EB%A6%AC%ED%95%A8&limit=10');
    const m = urls[0]!.auth.match(/signed-date=(\w+), signature=(\w+)/)!;
    expect(m[2]).toBe(createHmac('sha256', 'SK').update(`${m[1]}GET/v2/providers/affiliate_open_api/apis/openapi/products/searchkeyword=%EC%A0%95%EB%A6%AC%ED%95%A8&limit=10`).digest('hex'));
    await c.searchSignal('정리함'); // 캐시
    expect(urls.length).toBe(1);
    await c.searchSignal('b');
    expect(await c.searchSignal('c')).toBeNull(); // 시간당 2회 초과
    expect(urls.length).toBe(2);
  });
});
