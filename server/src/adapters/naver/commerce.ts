import bcrypt from 'bcryptjs';
import type { Logger } from '../../lib/logger.js';
import { HttpError, RateLimiter, retry } from '../../lib/util.js';
import type {
  CategoryMeta, ClaimStage, InvoiceInput, ItemSaleState, MarketClaim, MarketInquiry, MarketOrderLine, MarketOrderStatus, MarketPort,
  MarketProductStatus, MarketResult, RevenueLine, ShippingPlaces,
} from '../../ports/market.js';

/**
 * 네이버 스마트스토어 커머스API 어댑터.
 * 출처: https://apicenter.commerce.naver.com/docs/commerce-api/current (문서 v2.9x, 확인 2026-10-15)
 * - 인증: POST /v1/oauth2/token (client_secret_sign = base64(bcrypt(`${clientId}_${timestamp}`, clientSecret)), type=SELF, 3시간 유효)
 * - 상품: POST /v2/products, GET·PUT /v2/products/origin-products/{no}, PUT …/{no}/option-stock, PUT …/{no}/change-status,
 *         PATCH /v1/products/origin-products/multi-update, POST /v1/product-images/upload, GET /v1/categories
 * - 주문: GET /v1/pay-order/seller/product-orders/last-changed-statuses, POST …/product-orders/query, …/confirm(발주확인), …/dispatch(발송)
 * - 클레임: POST …/product-orders/{id}/claim/cancel/approve·request, …/claim/return/approve
 * - 문의: GET /v1/pay-user/inquiries, POST /v1/pay-merchant/inquiries/{no}/answer
 *
 * 우리 쪽 식별자
 * - sellerProductId = 원상품번호(originProductNo)
 * - vendorItemId = `NV{원상품번호}:{옵션 관리코드 숫자}` — 등록 시 옵션마다 sellerManagerCode `NVI{listing_items.id}`를 붙이고
 *   주문의 optionManageCode(옵션 없는 상품은 sellerProductCode)로 되찾는다
 * - shipmentBoxId = 상품주문번호(productOrderId), marketOrderId = 주문번호(orderId)
 * - 클레임 접수번호 = `{productOrderId}:{CANCEL|RETURN|EXCHANGE}`
 */
const BASE = 'https://api.commerce.naver.com/external';
export const NAVER_CODE_PREFIX = 'NVI';

export interface NaverCommerceOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  logger: Logger;
  requestsPerSecond?: number;
  fetchImpl?: typeof fetch;
  retryBaseMs?: number;
}

export class NaverCommerceClient {
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; until: number } | null = null;

  constructor(private readonly opts: NaverCommerceOptions) {
    this.limiter = new RateLimiter(opts.requestsPerSecond ?? 2);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get base(): string {
    return this.opts.baseUrl ?? BASE;
  }

  /** 전자서명: bcrypt(password=`${clientId}_${timestamp}`, salt=clientSecret) → base64 */
  static sign(clientId: string, clientSecret: string, timestamp: number): string {
    return Buffer.from(bcrypt.hashSync(`${clientId}_${timestamp}`, clientSecret), 'utf-8').toString('base64');
  }

  async accessToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.until) return this.token.value;
    const timestamp = Date.now();
    const form = new URLSearchParams({
      client_id: this.opts.clientId,
      timestamp: String(timestamp),
      client_secret_sign: NaverCommerceClient.sign(this.opts.clientId, this.opts.clientSecret, timestamp),
      grant_type: 'client_credentials',
      type: 'SELF',
    });
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: AbortSignal.timeout(30_000) });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) throw new HttpError(res.status, `스마트스토어 인증 실패(${res.status}): ${json.message ?? json.code ?? res.statusText}`, json);
    // 남은 시간이 30분 미만이면 새 토큰을 주므로 여유 있게 갱신
    this.token = { value: json.access_token, until: Date.now() + Math.max(60, (json.expires_in ?? 10800) - 1800) * 1000 };
    return this.token.value;
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; form?: FormData } = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') qs.append(k, String(v));
    const query = qs.toString();
    let refreshed = false;
    return retry(
      async () => {
        await this.limiter.take();
        const token = await this.accessToken();
        const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json;charset=UTF-8';
        const res = await this.fetchImpl(`${this.base}${path}${query ? `?${query}` : ''}`, {
          method,
          headers,
          body: opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
          signal: AbortSignal.timeout(60_000),
        });
        const text = await res.text();
        let json: any;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = { raw: text };
        }
        if (res.status === 401 && !refreshed) {
          refreshed = true;
          await this.accessToken(true);
          throw new HttpError(503, 'token refreshed', json); // 재시도
        }
        if (res.status === 429) {
          this.limiter.penalize(5_000);
          throw new HttpError(429, 'smartstore rate limited (429)', json);
        }
        if (!res.ok) {
          const inv = (json?.invalidInputs ?? []).map((x: any) => `${x.name}: ${x.message}`).join(', ');
          throw new HttpError(res.status, `smartstore ${method} ${path} → ${res.status}: ${json?.message ?? json?.code ?? res.statusText}${inv ? ` (${inv})` : ''}`, json);
        }
        return json as T;
      },
      { attempts: 3, baseMs: this.opts.retryBaseMs ?? 1000, retryable: (e) => e instanceof HttpError && (e.status === 429 || e.status >= 500) },
    );
  }
}

// ── 코드표 ──────────────────────────────────────────────────────────

/**
 * 쿠팡 택배사 코드 → 스마트스토어 택배사 코드(대부분 같음, 다른 것만). 없는 택배사는 '기타택배'(CH1).
 * 스마트스토어 코드 목록: 발송 처리 API deliveryCompanyCode(확인 2026-10-15)
 */
const NAVER_COURIER_DIFF: Record<string, string> = {
  NHLOGIS: 'NONGHYUP', BGF: 'CUPARCEL', CVS: 'CVSNET', GOODSTOLUCK: 'GOODTOLUCK', KURLYNEXTMILE: 'KURLY', LOTTEGLOBAL: 'HLCGLOBAL',
  SFEXPRESS: 'SFEX', HOMEINNOV: 'HOMEINNO', ZENIELSYSTEM: 'ZENIEL', CWAY: 'CWAYEXPRESS', TWOFASTEXP: 'TWOFASTEXPRESS', GNETWORK: 'GNETWORK',
};
const NAVER_COURIERS = new Set([
  'CJGLS', 'HYUNDAI', 'HANJIN', 'KGB', 'EPOST', 'KDEXP', 'DAESIN', 'ILYANG', 'CHUNIL', 'HDEXP', 'KUNYOUNG', 'NONGHYUP', 'CUPARCEL', 'CVSNET',
  'HONAM', 'SLX', 'HANDEX', 'YONGMA', 'SEBANG', 'HOMEPICK', 'HOMEPICKTODAY', 'KURLY', 'TEAMFRESH', 'CHAINLOGIS', 'VROONG', 'GOODTOLUCK', 'ANYTRACK',
  'WOORIHB', 'IK', 'GLOVIS', 'SELC', 'HANSSEM', 'CASA', 'LGE', 'KT', 'REGISTPOST', 'EMS', 'HLCGLOBAL', 'DHL', 'UPS', 'FEDEX', 'TNT', 'USPS', 'QXPRESS',
  'PANTOS', 'SFEX', 'KOREXG', 'GSIEXPRESS', 'GTSLOGIS', 'LOGISVALLEY', 'HIVECITY', 'WEMOVE', 'WEVILL', 'POOLATHOME', 'GDSP', 'KOKUSAI', 'DAELIM', 'CH1',
]);
export function naverCourierCode(coupangCode: string): string {
  const c = NAVER_COURIER_DIFF[coupangCode] ?? coupangCode;
  return NAVER_COURIERS.has(c) ? c : 'CH1';
}

const REASON: Record<string, string> = {
  INTENT_CHANGED: '구매 의사 취소', COLOR_AND_SIZE: '색상 및 사이즈 변경', WRONG_ORDER: '다른 상품 잘못 주문', PRODUCT_UNSATISFIED: '서비스 불만족',
  DELAYED_DELIVERY: '배송 지연', SOLD_OUT: '상품 품절', INCORRECT_INFO: '상품 정보 상이', DROPPED_DELIVERY: '배송 누락', BROKEN: '상품 파손',
  WRONG_DELIVERY: '오배송', WRONG_OPTION: '다른 옵션 배송', SIMPLE_INTENT_CHANGED: '단순 변심',
};

function kst(d: Date): string {
  // 2026-10-15T09:00:00.000+09:00
  return new Date(d.getTime() + 9 * 3600_000).toISOString().replace('Z', '+09:00');
}
const kstDay = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

/** 상품주문 → 우리 옵션 키 */
export function naverVendorItemId(originProductNo: string | number, code: string | null | undefined): string {
  const n = String(code ?? '').startsWith(NAVER_CODE_PREFIX) ? String(code).slice(NAVER_CODE_PREFIX.length) : String(code ?? '0');
  return `NV${originProductNo}:${n || '0'}`;
}
function parseVendorItemId(vid: string): { originNo: string; code: string } {
  const m = /^NV(\d+):(\w+)$/.exec(vid);
  if (!m) throw new Error(`스마트스토어 옵션 키가 아님: ${vid}`);
  return { originNo: m[1]!, code: `${NAVER_CODE_PREFIX}${m[2]}` };
}

function orderStatus(po: any): MarketOrderStatus {
  switch (po?.productOrderStatus) {
    case 'PAYED':
      return po.placeOrderStatus === 'OK' ? 'INSTRUCT' : 'ACCEPT';
    case 'DELIVERING':
      return 'DELIVERING';
    case 'DELIVERED':
    case 'PURCHASE_DECIDED':
    case 'EXCHANGED':
      return 'FINAL_DELIVERY';
    case 'CANCELED':
    case 'CANCELED_BY_NOPAYMENT':
    case 'RETURNED':
      return 'CANCELED';
    default:
      return 'UNKNOWN';
  }
}

export function parseProductOrder(row: any): MarketOrderLine {
  const po = row.productOrder ?? {};
  const o = row.order ?? {};
  const addr = po.shippingAddress ?? {};
  const status = orderStatus(po);
  return {
    marketOrderId: String(o.orderId ?? ''),
    shipmentBoxId: String(po.productOrderId ?? ''),
    vendorItemId: naverVendorItemId(po.originalProductId ?? po.productId ?? '0', po.optionManageCode || po.sellerProductCode),
    sellerProductId: po.originalProductId ? String(po.originalProductId) : undefined,
    itemName: [po.productName, po.productOption].filter(Boolean).join(', '),
    qty: Number(po.quantity ?? 1),
    paidAmount: Number(po.totalPaymentAmount ?? 0),
    orderedAt: new Date(o.paymentDate ?? o.orderDate ?? Date.now()),
    status,
    receiver: { name: String(addr.name ?? ''), phone: String(addr.tel1 ?? addr.tel2 ?? ''), addr1: String(addr.baseAddress ?? ''), addr2: String(addr.detailedAddress ?? ''), zip: String(addr.zipCode ?? '') },
    deliveryMessage: po.shippingMemo ?? undefined,
    shipBy: po.shippingDueDate ? String(po.shippingDueDate).slice(0, 10) : undefined,
    canceled: status === 'CANCELED',
    invoiceNumber: row.delivery?.trackingNumber ?? undefined,
    decided: po.productOrderStatus === 'PURCHASE_DECIDED',
    settlementAmount: typeof po.expectedSettlementAmount === 'number' ? po.expectedSettlementAmount : undefined,
  };
}

/** 상품주문의 현재 클레임 → 우리 클레임(취소·반품·교환) */
export function parseClaim(row: any): MarketClaim | null {
  const po = row.productOrder ?? {};
  const type0 = String(po.claimType ?? '');
  if (!['CANCEL', 'RETURN', 'EXCHANGE', 'ADMIN_CANCEL'].includes(type0)) return null;
  const type = type0 === 'ADMIN_CANCEL' ? 'CANCEL' : (type0 as 'CANCEL' | 'RETURN' | 'EXCHANGE');
  const status = String(po.claimStatus ?? '');
  const cur = row.currentClaim?.[type.toLowerCase()] ?? row.currentClaim?.cancel ?? {};
  let stage: ClaimStage;
  if (type === 'CANCEL') stage = status === 'CANCEL_REQUEST' ? 'stop_requested' : /REJECT/.test(status) ? 'withdrawn' : 'cancelled';
  else if (type === 'RETURN') stage = status === 'RETURN_DONE' ? 'return_done' : status === 'RETURN_REJECT' ? 'withdrawn' : status === 'COLLECT_DONE' ? 'return_collected' : 'return_requested';
  else stage = status === 'EXCHANGE_DONE' ? 'exchange_done' : status === 'EXCHANGE_REJECT' ? 'withdrawn' : 'exchange_open';
  const reasonCode = cur.cancelReason ?? cur.returnReason ?? cur.exchangeReason ?? '';
  return {
    receiptId: `${po.productOrderId}:${type}`,
    marketOrderId: String(row.order?.orderId ?? ''),
    vendorItemId: naverVendorItemId(po.originalProductId ?? po.productId ?? '0', po.optionManageCode || po.sellerProductCode),
    type,
    status,
    stage,
    count: Number(cur.requestQuantity ?? po.quantity ?? 1),
    shipmentBoxId: String(po.productOrderId ?? ''),
    reason: [REASON[reasonCode] ?? reasonCode, cur.cancelDetailedReason ?? cur.returnDetailedReason ?? cur.exchangeDetailedReason].filter(Boolean).join(' / '),
    requestedAt: new Date(cur.claimRequestDate ?? Date.now()),
  };
}

function result(res: any, id?: string): MarketResult {
  const fail = (res?.data?.failProductOrderInfos ?? []).find((x: any) => !id || String(x.productOrderId) === id);
  if (fail) return { ok: false, retryable: String(fail.code) === '9999', message: `${fail.code}: ${fail.message ?? ''}` };
  return { ok: true, retryable: false, message: 'OK' };
}

function httpResult(e: unknown): MarketResult {
  if (e instanceof HttpError) return { ok: false, retryable: e.status >= 500 || e.status === 429, message: e.message };
  throw e;
}

export class NaverMarket implements MarketPort {
  readonly name = 'naver';
  readonly label = '스마트스토어';
  constructor(readonly client: NaverCommerceClient) {}

  // ── 주문 ────────────────────────────────────────────────────────

  /** 변경된 상품주문(24시간 구간·more 페이지) */
  private async changed(from: Date, to: Date, type?: string): Promise<Array<{ productOrderId: string; claimType?: string }>> {
    const out: Array<{ productOrderId: string; claimType?: string }> = [];
    for (let cursor = from.getTime(); cursor < to.getTime(); cursor += 24 * 3600_000) {
      const end = new Date(Math.min(cursor + 24 * 3600_000 - 1000, to.getTime()));
      let moreFrom: string | undefined = kst(new Date(cursor));
      let moreSequence: string | undefined;
      for (let page = 0; page < 50 && moreFrom; page++) {
        const res: any = await this.client.request('GET', '/v1/pay-order/seller/product-orders/last-changed-statuses', { query: { lastChangedFrom: moreFrom, lastChangedTo: kst(end), lastChangedType: type, moreSequence } });
        for (const x of res?.data?.lastChangeStatuses ?? []) out.push({ productOrderId: String(x.productOrderId), claimType: x.claimType ?? undefined });
        moreFrom = res?.data?.more?.moreFrom;
        moreSequence = res?.data?.more?.moreSequence;
      }
    }
    return out;
  }

  async queryProductOrders(ids: string[]): Promise<any[]> {
    const out: any[] = [];
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += 300) {
      const res = await this.client.request('POST', '/v1/pay-order/seller/product-orders/query', { body: { productOrderIds: uniq.slice(i, i + 300) } });
      out.push(...(res?.data ?? []));
    }
    return out;
  }

  async listOrders(from: Date, to: Date, status: MarketOrderStatus): Promise<MarketOrderLine[]> {
    const ids = (await this.changed(from, to, 'PAYED')).map((x) => x.productOrderId);
    if (!ids.length) return [];
    return (await this.queryProductOrders(ids)).map(parseProductOrder).filter((l) => l.status === status);
  }

  async getOrderLines(shipmentBoxId: string): Promise<MarketOrderLine[]> {
    return (await this.queryProductOrders([shipmentBoxId])).map(parseProductOrder);
  }

  /** 발주 확인(쿠팡 상품준비중에 해당) — 이후 고객 취소는 '취소 요청'(판매자 승인) */
  async acknowledge(ids: string[]): Promise<Record<string, MarketResult>> {
    const out: Record<string, MarketResult> = {};
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30);
      try {
        const res = await this.client.request('POST', '/v1/pay-order/seller/product-orders/confirm', { body: { productOrderIds: chunk } });
        for (const id of chunk) out[id] = result(res, id);
      } catch (e) {
        for (const id of chunk) out[id] = httpResult(e);
      }
    }
    return out;
  }

  /** 발송 처리(송장 등록). 업체직송(DIRECT)은 직접 전달 */
  private async dispatch(productOrderId: string, courierCode: string, trackingNo: string): Promise<MarketResult> {
    const direct = courierCode === 'DIRECT';
    try {
      const res = await this.client.request('POST', '/v1/pay-order/seller/product-orders/dispatch', {
        body: {
          dispatchProductOrders: [{
            productOrderId,
            deliveryMethod: direct ? 'DIRECT_DELIVERY' : 'DELIVERY',
            ...(direct ? {} : { deliveryCompanyCode: naverCourierCode(courierCode), trackingNumber: trackingNo }),
            dispatchDate: kst(new Date()),
          }],
        },
      });
      return result(res, productOrderId);
    } catch (e) {
      return httpResult(e);
    }
  }

  uploadInvoice(input: InvoiceInput): Promise<MarketResult> {
    return this.dispatch(input.shipmentBoxId, input.courierCode, input.trackingNo);
  }

  // ── 클레임 ──────────────────────────────────────────────────────

  async listClaims(from: Date, to: Date): Promise<MarketClaim[]> {
    const ids = (await this.changed(from, to)).filter((x) => x.claimType).map((x) => x.productOrderId);
    if (!ids.length) return [];
    return (await this.queryProductOrders(ids)).map(parseClaim).filter((c): c is MarketClaim => !!c);
  }

  async getClaim(receiptId: string): Promise<MarketClaim | null> {
    const [productOrderId, type] = receiptId.split(':');
    const rows = await this.queryProductOrders([productOrderId!]);
    const c = rows.map(parseClaim).find((x) => x && (!type || x.type === type));
    return c ?? null;
  }

  /** 취소 요청 승인(쿠팡 출고중지완료에 해당 — 고객 환불) */
  async stopShipment(receiptId: string): Promise<MarketResult> {
    const id = receiptId.split(':')[0]!;
    try {
      return result(await this.client.request('POST', `/v1/pay-order/seller/product-orders/${id}/claim/cancel/approve`), id);
    } catch (e) {
      return httpResult(e);
    }
  }

  /** 이미 보낸 주문의 취소 요청 → 발송 처리(취소 요청은 거부되고 고객은 반품으로) */
  markShippedForClaim(receiptId: string, courierCode: string, trackingNo: string): Promise<MarketResult> {
    return this.dispatch(receiptId.split(':')[0]!, courierCode, trackingNo);
  }

  async confirmReturn(receiptId: string): Promise<MarketResult> {
    const id = receiptId.split(':')[0]!;
    try {
      return result(await this.client.request('POST', `/v1/pay-order/seller/product-orders/${id}/claim/return/approve`), id);
    } catch (e) {
      return httpResult(e);
    }
  }

  /** 판매자 취소(품절 등): 취소 요청 */
  async cancelOrder(input: { marketOrderId: string; vendorItemId: string; qty: number; reason: 'stock' | 'address' | 'price'; shipmentBoxId?: string }): Promise<MarketResult> {
    if (!input.shipmentBoxId) return { ok: false, retryable: false, message: '상품주문번호 없음' };
    const reason = input.reason === 'stock' ? 'SOLD_OUT' : 'INCORRECT_INFO';
    try {
      return result(await this.client.request('POST', `/v1/pay-order/seller/product-orders/${input.shipmentBoxId}/claim/cancel/request`, { body: { cancelReason: reason } }), input.shipmentBoxId);
    } catch (e) {
      return httpResult(e);
    }
  }

  // ── 상품 ────────────────────────────────────────────────────────

  async predictCategory(): Promise<{ code: string; name: string } | null> {
    return null; // 스마트스토어는 공급처 카테고리 경로로 매칭(modules/naver/category.ts)
  }

  async getCategoryMeta(code: string): Promise<CategoryMeta> {
    return { code, notices: [], requiredAttributes: [] };
  }

  async listCategories(): Promise<Array<{ id: string; name: string; wholeCategoryName: string }>> {
    const res = await this.client.request<any[]>('GET', '/v1/categories', { query: { last: true } });
    return (res ?? []).filter((c) => c.last !== false).map((c) => ({ id: String(c.id), name: String(c.name ?? ''), wholeCategoryName: String(c.wholeCategoryName ?? '') }));
  }

  /** 이미지 다건 업로드(최대 10개): 상품 이미지는 반드시 이 API로 올린 URL을 써야 함 */
  async uploadImages(urls: string[], fetchImpl: typeof fetch = fetch): Promise<string[]> {
    const form = new FormData();
    let n = 0;
    for (const u of urls.slice(0, 10)) {
      const res = await fetchImpl(u, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`이미지 내려받기 실패(${res.status}): ${u}`);
      const type = res.headers.get('content-type') ?? 'image/jpeg';
      const ext = type.includes('png') ? 'png' : type.includes('gif') ? 'gif' : 'jpg';
      form.append('imageFiles', new Blob([await res.arrayBuffer()], { type }), `img${n++}.${ext}`);
    }
    const res = await this.client.request('POST', '/v1/product-images/upload', { form });
    return (res?.images ?? []).map((x: any) => String(x.url));
  }

  async listShippingPlaces(): Promise<ShippingPlaces & { all: Array<{ id: number; type: string; name: string }> }> {
    const all: Array<{ id: number; type: string; name: string; address: string; postalCode: string; phone: string }> = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this.client.request('GET', '/v1/seller/addressbooks-for-page', { query: { page } });
      for (const a of res?.addressBooks ?? []) all.push({ id: a.addressBookNo, type: a.addressType, name: a.name ?? '', address: a.address ?? a.baseAddress ?? '', postalCode: a.postalCode ?? '', phone: a.phoneNumber1 ?? '' });
      if (!res?.totalPage || page >= res.totalPage) break;
    }
    return {
      all,
      outbound: all.filter((a) => /RELEASE/.test(a.type)).map((a) => ({ code: String(a.id), name: a.name, usable: true })),
      returns: all.filter((a) => /REFUND_OR_EXCHANGE/.test(a.type)).map((a) => ({ code: String(a.id), name: a.name, usable: true, zip: a.postalCode, address: a.address, addressDetail: '', phone: a.phone })),
    };
  }

  async createProduct(payload: unknown): Promise<{ sellerProductId: string }> {
    const res = await this.client.request('POST', '/v2/products', { body: payload });
    if (!res?.originProductNo) throw new Error(`스마트스토어 상품 등록 응답에 원상품번호 없음: ${JSON.stringify(res).slice(0, 200)}`);
    return { sellerProductId: String(res.originProductNo) };
  }

  async deleteProduct(sellerProductId: string): Promise<MarketResult> {
    try {
      await this.client.request('DELETE', `/v2/products/origin-products/${sellerProductId}`);
      return { ok: true, retryable: false, message: 'OK' };
    } catch (e) {
      return httpResult(e);
    }
  }

  async readProduct(originNo: string): Promise<any | null> {
    try {
      return await this.client.request('GET', `/v2/products/origin-products/${originNo}`);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  async getProductStatus(sellerProductId: string): Promise<MarketProductStatus> {
    const p = await this.readProduct(sellerProductId);
    if (!p) return { sellerProductId, status: 'UNKNOWN', rawStatus: '상품삭제', vendorItemIds: [] };
    const st = String(p.originProduct?.statusType ?? '');
    const status: MarketProductStatus['status'] = ['SALE', 'OUTOFSTOCK', 'SUSPENSION'].includes(st) ? 'APPROVED' : st === 'WAIT' ? 'IN_REVIEW' : ['REJECTION', 'PROHIBITION', 'UNADMISSION'].includes(st) ? 'REJECTED' : 'UNKNOWN';
    const combos: any[] = p.originProduct?.detailAttribute?.optionInfo?.optionCombinations ?? [];
    const single = p.originProduct?.detailAttribute?.sellerCodeInfo?.sellerManagementCode;
    const items = combos.length
      ? combos.map((c) => ({ vendorItemId: naverVendorItemId(sellerProductId, c.sellerManagerCode), itemName: [c.optionName1, c.optionName2, c.optionName3].filter(Boolean).join(' '), sellerCode: c.sellerManagerCode }))
      : [{ vendorItemId: naverVendorItemId(sellerProductId, single), itemName: '', sellerCode: single }];
    return { sellerProductId, status, rawStatus: st === 'DELETE' ? '상품삭제' : st, vendorItemIds: items.map((i) => i.vendorItemId), items, reason: p.originProduct?.statusType === 'REJECTION' ? '승인 반려' : undefined };
  }

  /** 옵션 값 바꾸기: 원상품 조회 → 대상 옵션 수정 → option-stock(옵션 상품) / multi-update(단일 상품) */
  private async editItem(vid: string, edit: { price?: number; stock?: number; usable?: boolean }): Promise<MarketResult> {
    let originNo: string, code: string;
    try {
      ({ originNo, code } = parseVendorItemId(vid));
    } catch (e) {
      return { ok: false, retryable: false, message: (e as Error).message };
    }
    try {
      const p = await this.readProduct(originNo);
      if (!p) return { ok: false, retryable: false, message: '스마트스토어에 상품 없음(삭제됨)' };
      const op = p.originProduct;
      const combos: any[] = op?.detailAttribute?.optionInfo?.optionCombinations ?? [];
      const same = { ok: true, retryable: false, message: '변경 없음' } as MarketResult;
      if (!combos.length) {
        // 값이 그대로면 호출하지 않음(동기화가 매시간 재고를 다시 보냄)
        const unchanged = (edit.price === undefined || Math.round(edit.price / 10) * 10 === op.salePrice)
          && (edit.stock === undefined || edit.stock === op.stockQuantity)
          && (edit.usable === undefined || edit.usable === (op.statusType === 'SALE'));
        if (unchanged) return same;
        const types: string[] = [];
        const vo: Record<string, unknown> = { originProductNo: Number(originNo) };
        if (edit.price !== undefined) (types.push('SALE_PRICE'), (vo.productSalePrice = { salePrice: Math.round(edit.price / 10) * 10 }));
        if (edit.stock !== undefined) (types.push('STOCK'), (vo.stockQuantity = edit.stock));
        if (edit.usable !== undefined) types.push(edit.usable ? 'PRODUCT_STATUS_SALE' : 'PRODUCT_STATUS_SUSPENSION');
        vo.multiUpdateTypes = types;
        await this.client.request('PATCH', '/v1/products/origin-products/multi-update', { body: { multiProductUpdateRequestVos: [vo] } });
        return { ok: true, retryable: false, message: 'OK' };
      }
      const target = combos.find((c) => c.sellerManagerCode === code);
      if (!target) return { ok: false, retryable: false, message: `옵션 없음(${code})` };
      const curPrice = Number(op.salePrice) + Number(target.price ?? 0);
      if ((edit.price === undefined || Math.round(edit.price / 10) * 10 === curPrice) && (edit.stock === undefined || edit.stock === target.stockQuantity) && (edit.usable === undefined || edit.usable === (target.usable !== false))) return same;
      // 옵션별 실제 가격 = 판매가 + 옵션가. 한 옵션 가격만 바꾸고 기준(최저가)을 다시 잡음
      const abs = new Map<any, number>(combos.map((c) => [c, Number(op.salePrice) + Number(c.price ?? 0)]));
      if (edit.price !== undefined) abs.set(target, Math.round(edit.price / 10) * 10);
      if (edit.stock !== undefined) target.stockQuantity = edit.stock;
      if (edit.usable !== undefined) target.usable = edit.usable;
      const base = Math.min(...combos.map((c) => abs.get(c)!));
      // 스마트스토어 정책: 옵션가는 판매가의 -50%~+50% 이내
      if (combos.some((c) => abs.get(c)! - base > base * 0.5)) return { ok: false, retryable: false, message: '옵션가가 판매가의 50%를 넘음(스마트스토어 정책) — 상품을 다시 등록해야 함' };
      await this.client.request('PUT', `/v1/products/origin-products/${originNo}/option-stock`, {
        body: {
          productSalePrice: { salePrice: base },
          optionInfo: { useStockManagement: true, optionCombinations: combos.map((c) => ({ id: c.id, stockQuantity: c.stockQuantity ?? 0, price: abs.get(c)! - base, usable: c.usable !== false })) },
        },
      });
      // 모든 옵션을 멈췄으면 상품 판매중지, 하나라도 다시 켜면 판매중
      const anyOn = combos.some((c) => c.usable !== false);
      if (edit.usable !== undefined && (anyOn ? op.statusType === 'SUSPENSION' : op.statusType === 'SALE')) {
        await this.client.request('PUT', `/v1/products/origin-products/${originNo}/change-status`, { body: { statusType: anyOn ? 'SALE' : 'SUSPENSION' } });
      }
      return { ok: true, retryable: false, message: 'OK' };
    } catch (e) {
      return httpResult(e);
    }
  }

  updatePrice(vendorItemId: string, price: number): Promise<MarketResult> {
    return this.editItem(vendorItemId, { price });
  }

  updateQuantity(vendorItemId: string, qty: number): Promise<MarketResult> {
    return this.editItem(vendorItemId, { stock: qty });
  }

  stopSale(vendorItemId: string): Promise<MarketResult> {
    return this.editItem(vendorItemId, { usable: false });
  }

  resumeSale(vendorItemId: string): Promise<MarketResult> {
    return this.editItem(vendorItemId, { usable: true });
  }

  async getItemSaleState(vendorItemId: string): Promise<ItemSaleState | null> {
    const { originNo, code } = parseVendorItemId(vendorItemId);
    const p = await this.readProduct(originNo);
    if (!p) return { onSale: false, quantity: null, price: null, deleted: true };
    const op = p.originProduct;
    const display = p.smartstoreChannelProduct?.channelProductDisplayStatusType !== 'SUSPENSION';
    const combos: any[] = op?.detailAttribute?.optionInfo?.optionCombinations ?? [];
    if (!combos.length) return { onSale: op.statusType === 'SALE' && display, quantity: op.stockQuantity ?? null, price: op.salePrice ?? null };
    const c = combos.find((x) => x.sellerManagerCode === code);
    if (!c) return { onSale: false, quantity: null, price: null, deleted: true };
    return { onSale: op.statusType === 'SALE' && display && c.usable !== false && (c.stockQuantity ?? 0) > 0, quantity: c.stockQuantity ?? null, price: Number(op.salePrice) + Number(c.price ?? 0) };
  }

  // ── 정산·CS ─────────────────────────────────────────────────────

  /** 정산은 상품주문의 정산 예정 금액(구매확정 시)으로 처리 → 매출내역 API는 쓰지 않음 */
  async listRevenue(): Promise<RevenueLine[]> {
    return [];
  }

  async listInquiries(from: Date, to: Date): Promise<MarketInquiry[]> {
    const out: MarketInquiry[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.client.request('GET', '/v1/pay-user/inquiries', { query: { startSearchDate: kstDay(from), endSearchDate: kstDay(to), page, size: 100 } });
      for (const q of res?.content ?? []) {
        out.push({ inquiryId: String(q.inquiryNo), kind: 'product', content: [q.title, q.inquiryContent].filter(Boolean).join('\n'), askedAt: new Date(q.inquiryRegistrationDateTime ?? Date.now()), answered: !!q.answered });
      }
      if (res?.last !== false) break;
    }
    return out;
  }

  async replyInquiry(inq: { inquiryId: string }, text: string): Promise<MarketResult> {
    try {
      await this.client.request('POST', `/v1/pay-merchant/inquiries/${inq.inquiryId}/answer`, { body: { answerComment: text } });
      return { ok: true, retryable: false, message: 'OK' };
    } catch (e) {
      return httpResult(e);
    }
  }
}
