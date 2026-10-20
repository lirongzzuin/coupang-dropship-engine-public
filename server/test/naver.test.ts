import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { NaverCommerceClient, NaverMarket, naverCourierCode, parseClaim, parseProductOrder } from '../src/adapters/naver/commerce.js';
import { createLogger } from '../src/lib/logger.js';
import { defaultSettings } from '../src/config/settings.js';
import { refreshListingStatuses } from '../src/modules/listing/service.js';
import { matchCategory } from '../src/modules/naver/category.js';
import { naverMirror } from '../src/modules/naver/mirror.js';
import { buildNaverPayload, withinOptionPriceRule } from '../src/modules/naver/payload.js';
import { pollClaims, pollFulfillment, pollNewOrders, processPending } from '../src/modules/orders/service.js';
import { claimAction, sellerCancel } from '../src/modules/orders/claims.js';
import { runSelection } from '../src/modules/selection/service.js';
import { syncListings } from '../src/modules/sync/service.js';
import { listedBefore } from '../src/modules/selection/service.js';
import type { CategoryMeta } from '../src/ports/market.js';
import type { SourceOption } from '../src/ports/source.js';
import { makeHarness, orderByBox, type TestHarness } from './helpers.js';

const log = createLogger('silent');
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// ── 어댑터(커머스API 요청·응답 형식) ─────────────────────────────────────

function mockApi(handler: (method: string, path: string, body: any, url: URL) => Response | Promise<Response>) {
  const calls: Array<{ method: string; path: string; body: any; auth: string; query: string }> = [];
  let tokens = 0;
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace('/external', '');
    if (path === '/v1/oauth2/token') {
      tokens++;
      const form = new URLSearchParams(String(init?.body));
      calls.push({ method: 'POST', path, body: Object.fromEntries(form), auth: '', query: '' });
      return json({ access_token: `tok${tokens}`, expires_in: 10800, token_type: 'Bearer' });
    }
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', path, body, auth: String((init?.headers as any)?.Authorization ?? ''), query: url.search });
    return handler(init?.method ?? 'GET', path, body, url);
  }) as unknown as typeof fetch;
  const secret = bcrypt.genSaltSync(4);
  const market = new NaverMarket(new NaverCommerceClient({ clientId: 'APPID', clientSecret: secret, logger: log, fetchImpl, retryBaseMs: 1, requestsPerSecond: 1000 }));
  return { market, calls, secret, tokens: () => tokens };
}

const productOrderRow = (over: Record<string, any> = {}) => ({
  order: { orderId: 'ORD1', paymentDate: '2026-10-15T10:00:00.000+09:00' },
  productOrder: {
    productOrderId: 'PO1', productOrderStatus: 'PAYED', placeOrderStatus: 'NOT_YET', quantity: 2, totalPaymentAmount: 25800, originalProductId: '900123',
    productName: '논슬립 수납 정리함', productOption: '옵션: 화이트 / M', optionManageCode: 'NVI55', shippingDueDate: '2026-10-17T23:59:59.000+09:00',
    shippingAddress: { name: '홍길동', tel1: '010-1111-2222', baseAddress: '서울 중구 세종대로 110', detailedAddress: '101호', zipCode: '04524' }, shippingMemo: '문 앞', expectedSettlementAmount: 24000,
    ...over,
  },
});

describe('스마트스토어 어댑터', () => {
  it('인증: 전자서명 = base64(bcrypt(clientId_timestamp, secret)), 토큰 재사용, 401이면 새 토큰으로 재시도', async () => {
    let first = true;
    const api = mockApi(() => {
      if (first) {
        first = false;
        return json({ code: 'GW.AUTHN', message: 'expired' }, 401);
      }
      return json([{ id: '1', name: '노트', wholeCategoryName: 'A>노트', last: true }]);
    });
    const cats = await api.market.listCategories();
    expect(cats).toEqual([{ id: '1', name: '노트', wholeCategoryName: 'A>노트' }]);
    const tok = api.calls.find((c) => c.path === '/v1/oauth2/token')!.body;
    expect(tok).toMatchObject({ client_id: 'APPID', grant_type: 'client_credentials', type: 'SELF' });
    const hash = Buffer.from(tok.client_secret_sign, 'base64').toString('utf-8');
    expect(bcrypt.compareSync(`APPID_${tok.timestamp}`, hash)).toBe(true);
    expect(api.tokens()).toBe(2); // 401 → 새 토큰
    expect(api.calls.at(-1)!.auth).toBe('Bearer tok2');
    await api.market.listCategories();
    expect(api.tokens()).toBe(2); // 유효한 토큰 재사용
  });

  it('상품주문 해석: 주문번호·상품주문번호·옵션 키(관리코드)·배송지·발송기한·정산 예정 금액, 상태 매핑', () => {
    const l = parseProductOrder(productOrderRow());
    expect(l).toMatchObject({ marketOrderId: 'ORD1', shipmentBoxId: 'PO1', vendorItemId: 'NV900123:55', qty: 2, paidAmount: 25800, status: 'ACCEPT', shipBy: '2026-10-17', settlementAmount: 24000, decided: false });
    expect(l.receiver).toEqual({ name: '홍길동', phone: '010-1111-2222', addr1: '서울 중구 세종대로 110', addr2: '101호', zip: '04524' });
    expect(parseProductOrder(productOrderRow({ placeOrderStatus: 'OK' })).status).toBe('INSTRUCT');
    expect(parseProductOrder(productOrderRow({ productOrderStatus: 'DELIVERING' })).status).toBe('DELIVERING');
    expect(parseProductOrder(productOrderRow({ productOrderStatus: 'PURCHASE_DECIDED' }))).toMatchObject({ status: 'FINAL_DELIVERY', decided: true });
    expect(parseProductOrder(productOrderRow({ productOrderStatus: 'CANCELED' })).canceled).toBe(true);
    // 옵션 없는 상품: 판매자 상품코드
    expect(parseProductOrder(productOrderRow({ optionManageCode: undefined, sellerProductCode: 'NVI77' })).vendorItemId).toBe('NV900123:77');
  });

  it('클레임 해석: 취소요청=출고중지요청, 취소완료, 철회, 반품 단계, 교환', () => {
    const c = (claimType: string, claimStatus: string, cur: Record<string, any> = {}) => parseClaim({ ...productOrderRow({ claimType, claimStatus }), currentClaim: { [claimType.toLowerCase()]: cur } });
    expect(c('CANCEL', 'CANCEL_REQUEST', { cancelReason: 'INTENT_CHANGED', claimRequestDate: '2026-10-15T11:00:00.000+09:00' })).toMatchObject({ receiptId: 'PO1:CANCEL', type: 'CANCEL', stage: 'stop_requested', reason: '구매 의사 취소', vendorItemId: 'NV900123:55', marketOrderId: 'ORD1' });
    expect(c('CANCEL', 'CANCEL_DONE')!.stage).toBe('cancelled');
    expect(c('CANCEL', 'CANCEL_REJECT')!.stage).toBe('withdrawn');
    expect(c('RETURN', 'RETURN_REQUEST')!.stage).toBe('return_requested');
    expect(c('RETURN', 'COLLECT_DONE')!.stage).toBe('return_collected');
    expect(c('RETURN', 'RETURN_DONE')!.stage).toBe('return_done');
    expect(c('EXCHANGE', 'EXCHANGE_REQUEST')!.stage).toBe('exchange_open');
    expect(c('EXCHANGE', 'EXCHANGE_DONE')!.stage).toBe('exchange_done');
    expect(parseClaim(productOrderRow())).toBeNull();
  });

  it('주문 조회: 변경 내역(more 페이지) → 상세 조회 → 결제완료·발주 미확인만', async () => {
    let page = 0;
    const api = mockApi((_m, path, body, url) => {
      if (path.endsWith('/last-changed-statuses')) {
        expect(url.searchParams.get('lastChangedType')).toBeNull(); // 유형으로 거르지 않음(결제 직후 배송지 변경한 주문 누락 방지)
        page++;
        return json({ data: page === 1 ? { lastChangeStatuses: [{ productOrderId: 'PO1' }], more: { moreFrom: '2026-10-15T10:30:00.000+09:00', moreSequence: '00001' } } : { lastChangeStatuses: [{ productOrderId: 'PO2' }] } });
      }
      if (path.endsWith('/product-orders/query')) {
        expect(body.productOrderIds).toEqual(['PO1', 'PO2']);
        return json({ data: [productOrderRow(), productOrderRow({ productOrderId: 'PO2', placeOrderStatus: 'OK' })] });
      }
      return json({}, 404);
    });
    const lines = await api.market.listOrders(new Date('2026-10-15T00:00:00Z'), new Date('2026-10-15T03:00:00Z'), 'ACCEPT');
    expect(lines.map((l) => l.shipmentBoxId)).toEqual(['PO1']);
    expect(api.calls.filter((c) => c.path.endsWith('last-changed-statuses'))[1]!.query).toContain('moreSequence=00001');
  });

  it('발주 확인·발송(택배사 코드 변환·업체직송)·취소 승인·반품 승인·판매자 취소 요청 형식, 실패 응답 해석', async () => {
    const api = mockApi((_m, path, body) => {
      if (path.endsWith('/confirm')) return json({ data: { successProductOrderInfos: [{ productOrderId: 'PO1' }], failProductOrderInfos: [{ productOrderId: 'PO2', code: '101009', message: '처리 불가 상태' }] } });
      if (path.endsWith('/dispatch')) return json({ data: { successProductOrderIds: [body.dispatchProductOrders[0].productOrderId], failProductOrderInfos: [] } });
      return json({ data: { successProductOrderIds: ['PO1'], failProductOrderInfos: [] } });
    });
    const ack = await api.market.acknowledge(['PO1', 'PO2']);
    expect(ack.PO1!.ok).toBe(true);
    expect(ack.PO2).toMatchObject({ ok: false, message: '101009: 처리 불가 상태' });
    expect((await api.market.uploadInvoice({ shipmentBoxId: 'PO1', marketOrderId: 'ORD1', vendorItemId: 'NV1:1', courierCode: 'NHLOGIS', trackingNo: '612345678901' })).ok).toBe(true);
    expect(api.calls.at(-1)!.body.dispatchProductOrders[0]).toMatchObject({ productOrderId: 'PO1', deliveryMethod: 'DELIVERY', deliveryCompanyCode: 'NONGHYUP', trackingNumber: '612345678901' });
    await api.market.uploadInvoice({ shipmentBoxId: 'PO1', marketOrderId: 'ORD1', vendorItemId: 'NV1:1', courierCode: 'DIRECT', trackingNo: '1' });
    expect(api.calls.at(-1)!.body.dispatchProductOrders[0]).toMatchObject({ deliveryMethod: 'DIRECT_DELIVERY' });
    expect(api.calls.at(-1)!.body.dispatchProductOrders[0].deliveryCompanyCode).toBeUndefined();
    await api.market.stopShipment('PO1:CANCEL');
    expect(api.calls.at(-1)!.path).toBe('/v1/pay-order/seller/product-orders/PO1/claim/cancel/approve');
    await api.market.confirmReturn('PO1:RETURN');
    expect(api.calls.at(-1)!.path).toBe('/v1/pay-order/seller/product-orders/PO1/claim/return/approve');
    await api.market.cancelOrder({ marketOrderId: 'ORD1', vendorItemId: 'NV1:1', qty: 1, reason: 'stock', shipmentBoxId: 'PO1' });
    expect(api.calls.at(-1)).toMatchObject({ path: '/v1/pay-order/seller/product-orders/PO1/claim/cancel/request', body: { cancelReason: 'SOLD_OUT' } });
    expect(naverCourierCode('CJGLS')).toBe('CJGLS');
    expect(naverCourierCode('BGF')).toBe('CUPARCEL');
    expect(naverCourierCode('DONGBU')).toBe('CH1'); // 스마트스토어 코드표에 없음 → 기타택배
  });

  it('옵션 가격·재고·판매중지: 원상품 조회 → 옵션가 재계산(최저가 기준) → option-stock, 정책(±50%) 위반은 거절, 단일 상품은 multi-update', async () => {
    let product: any = {
      originProduct: { statusType: 'SALE', salePrice: 10000, stockQuantity: 30, detailAttribute: { optionInfo: { optionCombinations: [
        { id: 11, optionName1: '화이트', stockQuantity: 10, price: 0, usable: true, sellerManagerCode: 'NVI1' },
        { id: 12, optionName1: '블랙', stockQuantity: 20, price: 1000, usable: true, sellerManagerCode: 'NVI2' },
      ] } } },
      smartstoreChannelProduct: { channelProductDisplayStatusType: 'ON' },
    };
    const api = mockApi((m, path) => {
      if (m === 'GET' && path === '/v2/products/origin-products/900') return json(product);
      if (m === 'GET' && path === '/v2/products/origin-products/901') return json({ originProduct: { statusType: 'SALE', salePrice: 9000, stockQuantity: 5, detailAttribute: { sellerCodeInfo: { sellerManagementCode: 'NVI3' } } } });
      return json({});
    });
    // 화이트(기준) 가격을 12000으로 → 기준이 블랙 11000으로 바뀜
    expect((await api.market.updatePrice('NV900:1', 12000)).ok).toBe(true);
    const put = api.calls.at(-1)!;
    expect(put).toMatchObject({ method: 'PUT', path: '/v1/products/origin-products/900/option-stock' });
    expect(put.body.productSalePrice.salePrice).toBe(11000);
    expect(put.body.optionInfo.optionCombinations).toEqual([{ id: 11, stockQuantity: 10, price: 1000, usable: true }, { id: 12, stockQuantity: 20, price: 0, usable: true }]);
    // 블랙을 20000으로 → 기준 10000 대비 +100% → 거절
    expect(await api.market.updatePrice('NV900:2', 20000)).toMatchObject({ ok: false, retryable: false });
    // 판매중지: 그 옵션만 사용 안 함, 모두 꺼지면 상품 판매중지
    await api.market.stopSale('NV900:2');
    expect(api.calls.at(-1)!.body.optionInfo.optionCombinations[1]).toMatchObject({ id: 12, usable: false });
    product = JSON.parse(JSON.stringify(product));
    product.originProduct.detailAttribute.optionInfo.optionCombinations[1].usable = false;
    await api.market.stopSale('NV900:1');
    expect(api.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/v1/products/origin-products/900/change-status', body: { statusType: 'SUSPENSION' } });
    // 단일 상품
    await api.market.updateQuantity('NV901:3', 7);
    expect(api.calls.at(-1)).toMatchObject({ method: 'PATCH', path: '/v1/products/origin-products/multi-update', body: { multiProductUpdateRequestVos: [{ originProductNo: 901, multiUpdateTypes: ['STOCK'], stockQuantity: 7 }] } });
    expect(await api.market.getItemSaleState('NV901:3')).toEqual({ onSale: true, quantity: 5, price: 9000 });
    // 값이 그대로면 수정 호출 없음(매시간 동기화)
    const n = api.calls.length;
    expect(await api.market.updateQuantity('NV901:3', 5)).toMatchObject({ ok: true, message: '변경 없음' });
    expect(await api.market.updateQuantity('NV900:1', 10)).toMatchObject({ ok: true, message: '변경 없음' });
    expect(api.calls.slice(n).every((c) => c.method === 'GET')).toBe(true);
    expect(await api.market.getItemSaleState('NV900:2')).toMatchObject({ onSale: false });
  });

  it('상품 상태: 판매중=승인, 옵션별 판매자 관리코드로 옵션 키, 없는 상품=삭제', async () => {
    const api = mockApi((_m, path) => {
      if (path === '/v2/products/origin-products/900') return json({ originProduct: { statusType: 'SALE', detailAttribute: { optionInfo: { optionCombinations: [{ id: 1, optionName1: '화이트', optionName2: '1개', sellerManagerCode: 'NVI5' }] } } } });
      return json({ code: 'NOT_FOUND' }, 404);
    });
    expect(await api.market.getProductStatus('900')).toMatchObject({ status: 'APPROVED', vendorItemIds: ['NV900:5'], items: [{ vendorItemId: 'NV900:5', itemName: '화이트 1개', sellerCode: 'NVI5' }] });
    expect(await api.market.getProductStatus('999')).toMatchObject({ rawStatus: '상품삭제' });
  });
});

// ── 등록 요청·카테고리 ───────────────────────────────────────────────────

describe('스마트스토어 상품 등록 요청', () => {
  const s = defaultSettings();
  const base = { title: '논슬립 수납 정리함', categoryId: '50002000', images: ['https://n/1.jpg', 'https://n/2.jpg'], detailHtml: '<p>상세</p>', detail: null, listingId: 9 };
  it('옵션 2단(공급처 옵션 × 수량), 판매가=최저가·옵션가=차액, 옵션마다 관리코드, 무료배송+제주 추가비, 고시 ETC', () => {
    const p: any = buildNaverPayload(s, {
      ...base,
      items: [
        { id: 1, units: 1, option: '화이트 / M', salePrice: 10000, stock: 30 },
        { id: 2, units: 2, option: '화이트 / M', salePrice: 14800, stock: 30 },
        { id: 3, units: 1, option: '블랙 / L', salePrice: 11000, stock: 10 },
      ],
    });
    const op = p.originProduct;
    expect(op).toMatchObject({ statusType: 'SALE', leafCategoryId: '50002000', salePrice: 10000, images: { representativeImage: { url: 'https://n/1.jpg' }, optionalImages: [{ url: 'https://n/2.jpg' }] } });
    expect(op.detailAttribute.optionInfo.optionCombinationGroupNames).toEqual({ optionGroupName1: '옵션', optionGroupName2: '수량' });
    expect(op.detailAttribute.optionInfo.optionCombinations).toEqual([
      { optionName1: '화이트 / M', optionName2: '1개', stockQuantity: 30, price: 0, usable: true, sellerManagerCode: 'NVI1' },
      { optionName1: '블랙 / L', optionName2: '1개', stockQuantity: 10, price: 1000, usable: true, sellerManagerCode: 'NVI3' },
      { optionName1: '화이트 / M', optionName2: '2개', stockQuantity: 15, price: 4800, usable: true, sellerManagerCode: 'NVI2' },
    ]);
    expect(op.deliveryInfo.deliveryFee).toEqual({ deliveryFeeType: 'FREE', deliveryFeePayType: 'PREPAID', deliveryFeeByArea: { deliveryAreaType: 'AREA_2', area2extraFee: 5000 } });
    expect(op.detailAttribute.productInfoProvidedNotice.productInfoProvidedNoticeType).toBe('ETC');
    // A/S 책임자·상담 전화는 하나만(둘 다면 네이버가 거부), 품명은 50자 미만
    const etc = op.detailAttribute.productInfoProvidedNotice.etc;
    expect(etc.afterServiceDirector).toBeUndefined();
    expect(etc).toHaveProperty('customerServicePhoneNumber');
    expect((buildNaverPayload(s, { ...base, title: '가'.repeat(80), items: [{ id: 1, units: 1, option: '', salePrice: 10000, stock: 3 }] } as any) as any).originProduct.detailAttribute.productInfoProvidedNotice.etc.itemName.length).toBeLessThan(50);
    expect(p.smartstoreChannelProduct).toEqual({ naverShoppingRegistration: true, channelProductDisplayStatusType: 'ON' });
  });

  it('옵션 하나면 단일 상품(판매자 관리코드로 주문 매칭), 수량 옵션만 있으면 1단, 원산지 매핑', () => {
    const one: any = buildNaverPayload(s, { ...base, items: [{ id: 7, units: 1, option: '', salePrice: 9900, stock: 5 }], detail: { origin: '대한민국' } as any });
    expect(one.originProduct.detailAttribute.optionInfo).toBeUndefined();
    expect(one.originProduct.detailAttribute.sellerCodeInfo.sellerManagementCode).toBe('NVI7');
    expect(one.originProduct.detailAttribute.originAreaInfo).toEqual({ originAreaCode: '00' });
    const units: any = buildNaverPayload(s, { ...base, items: [{ id: 1, units: 1, option: '', salePrice: 10000, stock: 50 }, { id: 2, units: 2, option: '', salePrice: 14000, stock: 50 }], detail: { origin: '중국' } as any });
    expect(units.originProduct.detailAttribute.optionInfo.optionCombinationGroupNames).toEqual({ optionGroupName1: '수량' });
    expect(units.originProduct.detailAttribute.originAreaInfo).toEqual({ originAreaCode: '04', content: '중국' });
  });

  it('옵션가 정책: 판매가의 50% 넘게 비싼 옵션(3개 묶음 등)은 뺌, 남아 있으면 오류', () => {
    const items = [{ salePrice: 10000 }, { salePrice: 15000 }, { salePrice: 15100 }, { salePrice: 28000 }];
    expect(withinOptionPriceRule(items).map((i) => i.salePrice)).toEqual([10000, 15000]);
    expect(() => buildNaverPayload(s, { ...base, items: [{ id: 1, units: 1, option: '', salePrice: 10000, stock: 1 }, { id: 2, units: 3, option: '', salePrice: 28000, stock: 1 }] })).toThrow(/50%/);
  });

  it('카테고리: 공급처 경로가 같은 체계면 정확히, 말단·상품명으로 보완, 점수 미달은 등록 안 함, 직접 지정 우선', () => {
    const cats = [
      { id: 'A', name: '캘린더/달력', wholeCategoryName: '생활/건강>문구/사무용품>다이어리/플래너>캘린더/달력' },
      { id: 'B', name: '스케줄러/플래너', wholeCategoryName: '생활/건강>문구/사무용품>다이어리/플래너>스케줄러/플래너' },
      { id: 'C', name: '바구니', wholeCategoryName: '생활/건강>수납/정리용품>바구니' },
      { id: 'D', name: '노트북가방', wholeCategoryName: '디지털/가전>노트북액세서리>노트북가방' },
    ];
    expect(matchCategory(cats, '생활/건강>문구/사무용품>다이어리/플래너>캘린더/달력', '2027 벽걸이 달력')!.id).toBe('A');
    expect(matchCategory(cats, '생활용품>수납/정리용품>바구니', '주방 수납 바스켓')!.id).toBe('C'); // 도매꾹식 경로
    expect(matchCategory(cats, null, '휴대용 노트북가방 15인치')!.id).toBe('D'); // 경로 없으면 상품명
    expect(matchCategory(cats, '식품>과자>쿠키', '버터 쿠키')).toBeNull();
    // 실데이터(2026-10-19): 공급처가 태블릿 파우치를 '태블릿PC'(KC 인증 본체)로 분류 → 상품명의 파우치로 액세서리 카테고리
    const tab = [
      { id: 'T', name: '태블릿PC', wholeCategoryName: '디지털/가전>태블릿PC' },
      { id: 'TP', name: '케이스/파우치', wholeCategoryName: '디지털/가전>태블릿PC액세서리>케이스/파우치' },
      { id: 'TS', name: '스탠드/Dock', wholeCategoryName: '디지털/가전>태블릿PC액세서리>스탠드/Dock' },
      { id: 'TE', name: '터치펜/기타', wholeCategoryName: '디지털/가전>태블릿PC액세서리>터치펜/기타' },
    ];
    expect(matchCategory(tab, '디지털/가전>태블릿PC', '미니멀 태블릿 수납 가방 클래식 핸디 파우치 패드 갤럭시 탭')!.id).toBe('TP');
    expect(matchCategory(tab, '디지털/가전>태블릿PC', '태블릿 거치대 스탠드 접이식')!.id).toBe('TS');
    expect(matchCategory(tab, '디지털/가전>태블릿PC', '10인치 태블릿 기타 학습용')!.id).toBe('T'); // '기타' 같은 일반어로는 안 옮김
    expect(matchCategory(cats, '식품>과자>쿠키', '버터 쿠키', { '식품>과자>쿠키': 'C' })!.id).toBe('C');
    // 실데이터(2026-10-19): 오너클랜 분류 오류 → 상품명과 안 맞으면 등록 안 함, 이름 차이(키홀더=키링)는 맞춤
    const real = [
      { id: 'K', name: '키링', wholeCategoryName: '패션잡화>패션소품>키링' },
      { id: 'S', name: '상대여', wholeCategoryName: '출산/육아>출산/돌기념품>돌잔치용품>상대여' },
      { id: 'W', name: '코디세트', wholeCategoryName: '패션의류>여성의류>코디세트' },
      { id: 'L', name: '슬립', wholeCategoryName: '패션의류>여성언더웨어/잠옷>슬립' },
    ];
    expect(matchCategory(real, '패션잡화>패션소품>키홀더', '강아지 고양이 열쇠고리 가방고리 아크릴')!.id).toBe('K');
    expect(matchCategory(real, '출산/육아>출산/돌기념품>돌잔치용품>상대여', '실링왁스 왁스씰 스탬프 편지 인장')).toBeNull();
    expect(matchCategory(real, '패션의류>여성의류>코디세트', '패드 논슬립 베란다 건식 타일 욕실 깔판')).toBeNull(); // '논슬립'의 '슬립'에 속지 않음
  });
});

// ── 통합: 쿠팡 판매 상품 → 스마트스토어 등록 → 주문·송장·정산·취소 ────────────────

const COUPANG = { vendorUserId: 'w', outboundShippingPlaceCode: '1', returnCenterCode: '1', companyContactNumber: '1588-0000', returnZipCode: '04524', returnAddress: '서울' };
const META: CategoryMeta = {
  code: '1', notices: [], requiredAttributes: ['색상', '사이즈', '수량'], attributeNames: ['색상', '사이즈', '수량'],
  requiredAttributeSpecs: [{ name: '색상', dataType: 'STRING' }, { name: '사이즈', dataType: 'STRING' }, { name: '수량', dataType: 'NUMBER', basicUnit: '개', usableUnits: ['개'] }],
};
const opt = (color: string, size: string, price: number, stock: number | null = 50): SourceOption => ({ name: `${color} / ${size}`, price, stock, attrs: [{ name: '색상', value: color }, { name: '사이즈', value: size }] });

let h: TestHarness;
afterEach(async () => h && (await h.close()));

/** 쿠팡 판매 중인 여러 옵션 상품 */
async function coupangActive(naverEnabled = true) {
  h = await makeHarness({ live: true, naver: true });
  await h.ctx.settings.update({ coupang: COUPANG, naver: { enabled: naverEnabled } });
  h.market.getCategoryMeta = async () => META;
  h.apiSource.add({ sourceItemId: 'V1', title: '논슬립 수납 정리함', price: 8000, stock: 200, categoryPath: '생활/건강>수납/정리용품>수납함', options: [opt('화이트', 'M', 8000), opt('블랙', 'L', 9000, 10)] });
  h.marketData.volume.set('수납 정리함', 20000);
  h.marketData.lowest.set('수납 정리함', 40000);
  expect((await runSelection(h.ctx, { keywords: ['수납 정리함'] })).autoListed).toBe(1);
  h.market.autoApprove = true;
  await refreshListingStatuses(h.ctx);
  return h.ctx.db.selectFrom('listings').selectAll().where('market', '=', 'coupang').where('status', '=', 'active').executeTakeFirstOrThrow();
}
const naverListing = () => h.ctx.db.selectFrom('listings').selectAll().where('market', '=', 'naver').executeTakeFirst();
const itemsOf = (id: number) => h.ctx.db.selectFrom('listing_items').selectAll().where('listing_id', '=', id).execute();

describe('스마트스토어 통합', () => {
  it('꺼져 있으면(naver.enabled=false) 등록·주문 수집 모두 안 함 — 쿠팡은 그대로', async () => {
    await coupangActive(false);
    expect((await naverMirror(h.ctx)).created).toBe(0);
    h.naver.seedOrder({ vendorItemId: 'NV1:1', orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    expect(h.naver.calls).not.toContain('listOrders');
    expect(await naverListing()).toBeUndefined();
  });

  it('쿠팡 판매 상품 → 스마트스토어 등록(카테고리 매칭·수수료 반영 가격·이미지 업로드·옵션 관리코드) → 승인 시 옵션 키 연결', async () => {
    const cl = await coupangActive();
    const r = await naverMirror(h.ctx);
    expect(r).toMatchObject({ created: 1, errors: [] });
    let nl = (await naverListing())!;
    expect(nl).toMatchObject({ status: 'pending_approval', category_code: '50002000', fee_rate_actual: 0.07, dry_run: false });
    const payload = h.naver.products.get(nl.seller_product_id!)!.payload;
    expect(h.naverApi.uploaded).toHaveLength(1); // 쿠팡에 쓴 이미지를 스마트스토어 서버로
    expect(payload.originProduct.images.representativeImage.url).toMatch(/pstatic/);
    expect(payload.originProduct.detailAttribute.optionInfo.optionCombinations.every((c: any) => /^NVI\d+$/.test(c.sellerManagerCode))).toBe(true);
    expect(payload.originProduct.deliveryInfo.claimDeliveryInfo).toMatchObject({ shippingAddressId: 1001, returnAddressId: 1002 });
    // 수수료가 낮아 같은 옵션이 쿠팡보다 싸거나 같음
    const cItems = await itemsOf(cl.id);
    const nItems = await itemsOf(nl.id);
    for (const ni of nItems) {
      const ci = cItems.find((c) => c.source_option === ni.source_option && c.unit_qty === ni.unit_qty)!;
      expect(ni.sale_price).toBeLessThanOrEqual(ci.sale_price);
    }
    // 같은 상품 다시 실행 → 중복 등록 안 함
    expect((await naverMirror(h.ctx)).created).toBe(0);
    h.naver.autoApprove = true;
    await refreshListingStatuses(h.ctx);
    nl = (await naverListing())!;
    expect(nl.status).toBe('active');
    for (const it of await itemsOf(nl.id)) expect(it.vendor_item_id).toBe(`NV${nl.seller_product_id}:${it.id}`);
    expect(h.notifier.titles()).toContain('스마트스토어 판매 시작');
    // 쿠팡 선정·재등록 판단은 스마트스토어 상품과 무관
    expect(await listedBefore(h.ctx, 'mockapi', 'V1')).toBe(true); // 쿠팡 상품 때문(스마트스토어와 별개)
  });

  it('스마트스토어 주문 → 발주 확인 → 고객이 고른 옵션으로 오너클랜 발주 → 송장 발송 처리 → 구매확정 시 정산(이익 기록)', async () => {
    await coupangActive();
    await naverMirror(h.ctx);
    h.naver.autoApprove = true;
    await refreshListingStatuses(h.ctx);
    const nl = (await naverListing())!;
    const black = (await itemsOf(nl.id)).find((i) => i.source_option === '블랙 / L' && i.unit_qty === 1)!;
    const line = h.naver.seedOrder({ vendorItemId: black.vendor_item_id!, paidAmount: black.sale_price, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    let o = await orderByBox(h, line.shipmentBoxId);
    expect(o).toMatchObject({ market: 'naver', status: 'PURCHASED', listing_id: nl.id });
    expect(h.naver.calls).toContain('acknowledge');
    expect([...h.apiSource.orders.values()].at(-1)!.req.option).toBe('블랙 / L');
    expect(h.notifier.titles()).toContain('새 주문 — 자동 발주 완료');
    h.apiSource.ship(o.source_order_id!, '612345678901', 'CJ대한통운');
    await pollFulfillment(h.ctx);
    o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('TRACKING_UPLOADED');
    expect(h.naver.invoices[0]).toMatchObject({ shipmentBoxId: line.shipmentBoxId, courierCode: 'CJGLS', trackingNo: '612345678901' });
    expect(h.market.invoices).toHaveLength(0); // 쿠팡에는 올리지 않음
    h.naver.setStatus(line.shipmentBoxId, 'FINAL_DELIVERY');
    await pollFulfillment(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('DELIVERED');
    // 구매확정 → 정산 예정 금액으로 정산
    for (const l of h.naver.orders.get(line.shipmentBoxId)!) Object.assign(l, { decided: true, settlementAmount: Math.round(black.sale_price * 0.93) });
    await pollFulfillment(h.ctx);
    o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('SETTLED');
    expect(o.settlement_amount).toBe(Math.round(black.sale_price * 0.93));
    expect(o.profit).toBe(o.settlement_amount! - (o.purchase_cost ?? 0) - (o.purchase_shipping ?? 0));
  });

  it('스마트스토어 고객 취소 요청 → 오너클랜 취소 → 스마트스토어 취소 승인(쿠팡은 건드리지 않음)', async () => {
    await coupangActive();
    await naverMirror(h.ctx);
    h.naver.autoApprove = true;
    await refreshListingStatuses(h.ctx);
    const nl = (await naverListing())!;
    const item = (await itemsOf(nl.id))[0]!;
    const line = h.naver.seedOrder({ vendorItemId: item.vendor_item_id!, paidAmount: item.sale_price, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    await processPending(h.ctx);
    h.naver.claim({ receiptId: `${line.shipmentBoxId}:CANCEL`, marketOrderId: line.marketOrderId, vendorItemId: item.vendor_item_id!, type: 'CANCEL', stage: 'stop_requested', requestedAt: h.clock.now() });
    await pollClaims(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCELLED');
    expect(h.naver.claimActions.map((a) => a.action)).toEqual(['stopShipment']);
    expect(h.market.claimActions).toHaveLength(0);
  });

  /** 스마트스토어 판매중 상품 1개 + 주문 1건 → 자동 발주까지 */
  async function naverOrder() {
    await coupangActive();
    await naverMirror(h.ctx);
    h.naver.autoApprove = true;
    await refreshListingStatuses(h.ctx);
    const nl = (await naverListing())!;
    const item = (await itemsOf(nl.id))[0]!;
    const line = h.naver.seedOrder({ vendorItemId: item.vendor_item_id!, paidAmount: item.sale_price, orderedAt: h.clock.now() });
    await pollNewOrders(h.ctx);
    return { nl, item, line };
  }

  it('고객 취소 안내 문구는 스마트스토어 용어(취소 승인) — 쿠팡 출고중지 아님', async () => {
    const { item, line } = await naverOrder();
    await processPending(h.ctx);
    h.naver.claim({ receiptId: `${line.shipmentBoxId}:CANCEL`, marketOrderId: line.marketOrderId, vendorItemId: item.vendor_item_id!, type: 'CANCEL', stage: 'stop_requested', requestedAt: h.clock.now() });
    await pollClaims(h.ctx);
    const texts = h.notifier.sent.map((m: any) => `${m.title} ${m.body}`).join('\n');
    expect(texts).toMatch(/스마트스토어 취소 승인/);
    expect(texts).not.toMatch(/쿠팡 출고중지|쿠팡에 이미출고|쿠팡은 이미 환불/);
  });

  it('발주 확인 전에 고객이 바로 취소(즉시 취소) → 공급처 발주 안 함, 취소로 정리', async () => {
    const { line } = await naverOrder();
    h.naver.setStatus(line.shipmentBoxId, 'CANCELED' as any);
    for (const l of h.naver.orders.get(line.shipmentBoxId)!) l.canceled = true;
    await processPending(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCELLED');
    expect(h.apiSource.orders.size).toBe(0);
  });

  it('반품: 배송 후 반품 요청(스마트스토어 안내) → 수거 완료 → [반품 승인] → 스마트스토어 반품 승인(환불) → 반품 완료', async () => {
    const { item, line } = await naverOrder();
    await processPending(h.ctx);
    let o = await orderByBox(h, line.shipmentBoxId);
    h.apiSource.ship(o.source_order_id!, '612345678901', 'CJ대한통운');
    await pollFulfillment(h.ctx);
    h.naver.setStatus(line.shipmentBoxId, 'FINAL_DELIVERY');
    await pollFulfillment(h.ctx);
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('DELIVERED');
    const rid = `${line.shipmentBoxId}:RETURN`;
    h.naver.claim({ receiptId: rid, marketOrderId: line.marketOrderId, vendorItemId: item.vendor_item_id!, type: 'RETURN', stage: 'return_requested', reason: '단순 변심', returnShippingCharge: -6000, requestedAt: h.clock.now() });
    await pollClaims(h.ctx);
    o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('RETURN_REQUESTED');
    expect(h.notifier.titles()).toContain('스마트스토어 반품 요청');
    expect(h.notifier.sent.at(-1)!.body).toMatch(/고객 부담 6,000원.*\n?[\s\S]*스마트스토어는 판매자가 승인해야 환불/);
    h.naver.setClaimStage(rid, 'return_collected');
    await pollClaims(h.ctx);
    expect(h.notifier.sent.at(-1)!.body).toMatch(/스마트스토어 반품 수거가 완료/);
    const claim = await h.ctx.db.selectFrom('order_claims').selectAll().where('order_id', '=', o.id).executeTakeFirstOrThrow();
    await claimAction(h.ctx, o.id, claim.id, { action: 'approve_return' }, 'admin');
    expect(h.naver.claimActions.map((a) => a.action)).toContain('confirmReturn');
    await pollClaims(h.ctx);
    o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('RETURNED');
    expect(h.market.claimActions).toHaveLength(0); // 쿠팡은 건드리지 않음
  });

  it('공급처 품절 주문 → 발주 안 함·판매중지 → [판매자 취소] → 스마트스토어 판매 취소(품절 사유)', async () => {
    const { nl, line } = await naverOrder();
    const sp = await h.ctx.db.selectFrom('source_products').select('source_item_id').where('id', '=', nl.source_product_id).executeTakeFirstOrThrow();
    const p = h.apiSource.products.get(sp.source_item_id)!;
    p.stock = 0;
    for (const op of p.options ?? []) op.stock = 0;
    await processPending(h.ctx);
    const o = await orderByBox(h, line.shipmentBoxId);
    expect(o.status).toBe('OUT_OF_STOCK');
    expect(h.apiSource.orders.size).toBe(0);
    const r = await sellerCancel(h.ctx, o.id, 'stock', 'admin');
    expect(r.message).toMatch(/스마트스토어 주문을 취소했습니다/);
    expect(h.naver.sellerCancels[0]).toMatchObject({ reason: 'stock', marketOrderId: line.marketOrderId });
    expect((await orderByBox(h, line.shipmentBoxId)).status).toBe('CANCELLED');
  });

  it('동기화: 공급처 옵션 품절 → 스마트스토어 그 옵션만 판매중지(쿠팡도 각각), 원가 상승 → 스마트스토어 가격도 조정', async () => {
    const cl = await coupangActive();
    await naverMirror(h.ctx);
    h.naver.autoApprove = true;
    await refreshListingStatuses(h.ctx);
    const nl = (await naverListing())!;
    const p = h.apiSource.products.get('V1')!;
    p.options![1]!.stock = 0; // 블랙 품절
    await syncListings(h.ctx);
    const nBlack = (await itemsOf(nl.id)).find((i) => i.source_option === '블랙 / L')!;
    const cBlack = (await itemsOf(cl.id)).find((i) => i.source_option === '블랙 / L')!;
    expect(h.naver.items.get(nBlack.vendor_item_id!)!.onSale).toBe(false);
    expect(h.market.items.get(cBlack.vendor_item_id!)!.onSale).toBe(false);
    p.options![0]!.price = 9500; // 화이트 원가 상승
    await syncListings(h.ctx);
    const nWhite = (await itemsOf(nl.id)).find((i) => i.source_option === '화이트 / M' && i.unit_qty === 1)!;
    expect(h.naver.items.get(nWhite.vendor_item_id!)!.price).toBe(nWhite.sale_price);
    expect(nWhite.sale_price).toBeGreaterThan(0);
  });

  it('카테고리를 못 맞추면 건너뛰고 7일 동안 재시도 안 함, 등록 API 실패는 반려로 기록·알림', async () => {
    await coupangActive();
    h.naverApi.categories = [{ id: 'X', name: '쿠키', wholeCategoryName: '식품>과자>쿠키' }];
    await h.ctx.kv.set('naver.categories', null);
    let r = await naverMirror(h.ctx);
    expect(r.created).toBe(0);
    expect(r.skipped[0]).toMatch(/카테고리 매칭 실패/);
    r = await naverMirror(h.ctx);
    expect(r.skipped).toHaveLength(0); // 기억
    // 8일 뒤, 카테고리는 맞는데 등록 API 실패
    h.clock.advanceMinutes(60 * 24 * 8);
    h.naverApi.categories = [{ id: '50002000', name: '수납함', wholeCategoryName: '생활/건강>수납/정리용품>수납함' }];
    await h.ctx.kv.set('naver.categories', null);
    h.naver.failNext.set('createProduct', 1);
    r = await naverMirror(h.ctx);
    expect(r.errors).toHaveLength(1);
    expect((await naverListing())!).toMatchObject({ status: 'rejected' });
    expect(h.notifier.titles().some((t) => t.startsWith('스마트스토어 등록 요청 0개 · 실패 1개'))).toBe(true);
  });

  it('KC·어린이제품 인증이 필요한 카테고리 거부는 실패가 아니라 건너뜀(알림 경고 없음)', async () => {
    await coupangActive();
    h.naver.createProduct = async () => { throw new Error('productCertificationInfos: KC 인증대상 인증 종류를 선택하셔야 합니다. | modelName: 어린이인증 대상 카테고리 상품은 모델명 입력이 필수입니다'); };
    const r = await naverMirror(h.ctx);
    expect(r.errors).toHaveLength(0);
    expect(r.skipped[0]).toMatch(/인증 필요 카테고리/);
    expect(h.notifier.titles().some((t) => t.includes('실패'))).toBe(false);
  });

  it('등록 오류 수정 뒤 한 번: 예전 등록 실패(반려) 행·재시도 메모를 지우고 바로 다시 등록', async () => {
    const cl = await coupangActive();
    const now = h.clock.now();
    await h.ctx.db.insertInto('listings').values({ candidate_id: cl.candidate_id, source_product_id: cl.source_product_id, market: 'naver', title: cl.title, search_tags: '[]', category_code: 'X', category_name: 'X', sale_price: 1, floor_price: 1, markup: 0.3, target_markup: 0.3, fee_rate_actual: 0.07, source_option: null, images: '[]', status: 'rejected', status_reason: '스마트스토어 등록 실패: afterServiceDirector: A/S 책임자와 전화번호', dry_run: false, created_at: now, updated_at: now } as any).execute();
    await h.ctx.kv.set('naver.skip', { [String(cl.source_product_id)]: now.toISOString() });
    const r = await naverMirror(h.ctx);
    expect(r.created).toBe(1);
    const rows = await h.ctx.db.selectFrom('listings').select('status').where('market', '=', 'naver').execute();
    expect(rows.map((x) => x.status)).toEqual(['pending_approval']);
    expect(await h.ctx.kv.get('naver.mirrorReset')).toBe(2);
  });

  it('등록 API 오류가 3번 나면 그 회차는 중단(같은 원인으로 전부 실패 방지)', async () => {
    await coupangActive();
    const cl = await h.ctx.db.selectFrom('listings').selectAll().where('market', '=', 'coupang').executeTakeFirstOrThrow();
    const now = h.clock.now();
    for (let i = 0; i < 4; i++) {
      const sp = await h.ctx.db.insertInto('source_products').values({ ...(await h.ctx.db.selectFrom('source_products').selectAll().where('id', '=', cl.source_product_id).executeTakeFirstOrThrow()), id: undefined, source_item_id: `X${i}` } as any).returning('id').executeTakeFirstOrThrow();
      await h.ctx.db.insertInto('listings').values({ ...cl, id: undefined, source_product_id: sp.id, seller_product_id: `S${i}`, listed_at: now } as any).execute();
    }
    await h.ctx.settings.update({ naver: { perRun: 10 } });
    let calls = 0;
    h.naver.createProduct = async () => { calls++; throw new Error('서버 오류'); };
    const r = await naverMirror(h.ctx);
    expect(r.errors).toHaveLength(3);
    expect(calls).toBe(3);
  });
});
