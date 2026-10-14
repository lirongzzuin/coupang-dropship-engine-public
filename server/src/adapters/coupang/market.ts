import type {
  CategoryMeta, InvoiceInput, MarketClaim, MarketInquiry, MarketOrderLine, MarketOrderStatus, MarketPort,
  ItemSaleState, MarketProductStatus, MarketResult, RevenueLine, ShippingPlaces,
} from '../../ports/market.js';
import { HttpError, kstDate, kstIsoMinute } from '../../lib/util.js';
import { type CoupangClient, money } from './client.js';

/**
 * 쿠팡 OPEN API 어댑터. 엔드포인트 출처: https://developers.coupang.com/ko/api (확인 2026-10-13)
 * 사양 변경 시 이 파일만 수정한다.
 */
const SELLER = '/v2/providers/seller_api/apis/api/v1/marketplace';
/** 매출내역 1회 조회 최대 일수(쿠팡 한도 1개월 미만보다 넉넉히) */
const REVENUE_WINDOW_DAYS = 14;

/** YYYY-MM-DD 기간을 최대 days 일(양 끝 포함)씩 겹치지 않게 나눔 */
export function dateWindows(fromDate: string, toDate: string, days: number): Array<[string, string]> {
  const DAY = 86400_000;
  const d = (s: string) => Date.parse(`${s}T00:00:00Z`);
  const f = (t: number) => new Date(t).toISOString().slice(0, 10);
  const out: Array<[string, string]> = [];
  for (let start = d(fromDate); start <= d(toDate); start += days * DAY) out.push([f(start), f(Math.min(start + (days - 1) * DAY, d(toDate)))]);
  return out;
}
const OPEN = '/v2/providers/openapi/apis/api';

export class CoupangMarket implements MarketPort {
  readonly name = 'coupang';
  constructor(
    private readonly client: CoupangClient,
    private readonly getWingUserId: () => Promise<string>,
  ) {}

  private get v(): string {
    return this.client.vendorId;
  }

  // ── 주문 ──────────────────────────────────────────────────────────

  async listOrders(from: Date, to: Date, status: MarketOrderStatus): Promise<MarketOrderLine[]> {
    // 분단위 전체 조회: 구간 24시간 이내
    const out: MarketOrderLine[] = [];
    let cursor = from.getTime();
    while (cursor < to.getTime()) {
      const end = Math.min(cursor + 24 * 3600_000 - 60_000, to.getTime());
      let nextToken: string | undefined;
      do {
        const res = await this.client.request('GET', `${OPEN}/v5/vendors/${this.v}/ordersheets`, {
          query: { createdAtFrom: kstIsoMinute(new Date(cursor)), createdAtTo: kstIsoMinute(new Date(end)), status, searchType: 'timeFrame', nextToken },
        });
        for (const sheet of res?.data ?? []) out.push(...parseSheet(sheet));
        nextToken = res?.nextToken || undefined;
      } while (nextToken);
      cursor = end + 60_000;
    }
    return out;
  }

  async getOrderLines(shipmentBoxId: string): Promise<MarketOrderLine[]> {
    const res = await this.client.request('GET', `${OPEN}/v5/vendors/${this.v}/ordersheets/${shipmentBoxId}`);
    const data = res?.data;
    const sheets = Array.isArray(data) ? data : data ? [data] : [];
    return sheets.flatMap(parseSheet);
  }

  async acknowledge(shipmentBoxIds: string[]): Promise<Record<string, MarketResult>> {
    const out: Record<string, MarketResult> = {};
    for (let i = 0; i < shipmentBoxIds.length; i += 50) {
      const chunk = shipmentBoxIds.slice(i, i + 50);
      const res = await this.client.request('PATCH', `${OPEN}/v4/vendors/${this.v}/ordersheets/acknowledgement`, {
        body: { vendorId: this.v, shipmentBoxIds: chunk.map(Number) },
      });
      for (const r of res?.data?.responseList ?? []) {
        out[String(r.shipmentBoxId)] = { ok: !!r.succeed, retryable: !!r.retryRequired, message: r.resultMessage ?? r.resultCode ?? '' };
      }
      for (const id of chunk) out[id] ??= { ok: false, retryable: true, message: res?.data?.responseMessage ?? 'no result' };
    }
    return out;
  }

  async uploadInvoice(input: InvoiceInput): Promise<MarketResult> {
    const res = await this.client.request('POST', `${OPEN}/v4/vendors/${this.v}/orders/invoices`, {
      body: {
        vendorId: this.v,
        orderSheetInvoiceApplyDtos: [
          {
            shipmentBoxId: Number(input.shipmentBoxId),
            orderId: Number(input.marketOrderId),
            vendorItemId: Number(input.vendorItemId),
            deliveryCompanyCode: input.courierCode,
            invoiceNumber: input.trackingNo,
            splitShipping: !!input.splitShipping,
            preSplitShipped: !!input.preSplitShipped,
            estimatedShippingDate: '',
          },
        ],
      },
    });
    const r = res?.data?.responseList?.[0];
    if (!r) return { ok: res?.data?.responseCode === 0, retryable: true, message: res?.data?.responseMessage ?? 'no result' };
    return { ok: !!r.succeed, retryable: !!r.retryRequired, message: r.resultMessage ?? r.resultCode ?? '' };
  }

  /**
   * 취소·반품·교환 요청. 반품은 상태별로 조회(status 없이 조회하면 orderId 가 필요하다고 문서에 명시) — RU·UC 는 겹칠 수 있어 접수번호로 합침.
   * 취소(cancelType=CANCEL)는 결제완료 단계 즉시취소(이미 환불됨). 조회 구간은 최대 31일.
   */
  async listClaims(from: Date, to: Date): Promise<MarketClaim[]> {
    const byKey = new Map<string, MarketClaim>();
    const fmt = (d: Date) => kstIsoMinute(d).slice(0, 16);
    const span = Math.max(from.getTime(), to.getTime() - 30 * 86400_000);
    const base = { searchType: 'timeFrame', createdAtFrom: fmt(new Date(span)), createdAtTo: fmt(to) };
    const queries: Array<Record<string, string>> = [{ ...base, cancelType: 'CANCEL' }, ...['RU', 'UC', 'PR', 'CC'].map((status) => ({ ...base, status }))];
    for (const query of queries) {
      const res = await this.client.request('GET', `${OPEN}/v6/vendors/${this.v}/returnRequests`, { query });
      for (const r of res?.data ?? []) for (const c of parseReturnReceipt(r)) byKey.set(`${c.receiptId}:${c.vendorItemId ?? ''}`, c);
    }
    // 교환 요청(실측 2026-10-14: v4 exchangeRequests 200 OK, 조회 구간 7일 미만 — 넘으면 400) → 6일씩 나눠 조회
    const sec = (d: Date) => `${kstIsoMinute(d).slice(0, 16)}:00`;
    for (let cursor = span; cursor < to.getTime(); cursor += 6 * 86400_000) {
      const end = new Date(Math.min(cursor + 6 * 86400_000, to.getTime()));
      let nextToken: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await this.client.request('GET', `${OPEN}/v4/vendors/${this.v}/exchangeRequests`, { query: { createdAtFrom: sec(new Date(cursor)), createdAtTo: sec(end), maxPerPage: 50, nextToken } });
        for (const r of res?.data ?? []) for (const c of parseExchange(r)) byKey.set(`${c.receiptId}:${c.vendorItemId ?? ''}`, c);
        nextToken = res?.nextToken || undefined;
        if (!nextToken) break;
      }
    }
    return [...byKey.values()];
  }

  /** 반품·취소 접수 단건. 400 "취소반품접수내역이 존재하지 않습니다" = 고객 철회 */
  async getClaim(receiptId: string): Promise<MarketClaim | null> {
    try {
      const res = await this.client.request('GET', `${OPEN}/v6/vendors/${this.v}/returnRequests/${receiptId}`);
      const data = Array.isArray(res?.data) ? res.data : res?.data ? [res.data] : [];
      return data.flatMap(parseReturnReceipt)[0] ?? null;
    } catch (e) {
      if (e instanceof HttpError && e.status === 400 && /존재하지 않|철회/.test(e.message)) {
        return { receiptId, marketOrderId: '', type: 'RETURN', status: 'WITHDRAWN', stage: 'withdrawn', reason: '', requestedAt: new Date() };
      }
      if (e instanceof HttpError && e.status === 400) return null;
      throw e;
    }
  }

  stopShipment(receiptId: string, count: number): Promise<MarketResult> {
    return this.claimAction('PATCH', `${OPEN}/v4/vendors/${this.v}/returnRequests/${receiptId}/stoppedShipment`, { vendorId: this.v, receiptId: Number(receiptId), cancelCount: count });
  }

  markShippedForClaim(receiptId: string, courierCode: string, trackingNo: string): Promise<MarketResult> {
    return this.claimAction('PATCH', `${OPEN}/v4/vendors/${this.v}/returnRequests/${receiptId}/completedShipment`, { vendorId: this.v, receiptId: Number(receiptId), deliveryCompanyCode: courierCode, invoiceNumber: trackingNo });
  }

  /** 입고 확인(반품접수 상태일 때) → 승인(입고완료 상태일 때). 이미 처리된 단계는 건너뜀 */
  async confirmReturn(receiptId: string, count: number): Promise<MarketResult> {
    const cur = await this.getClaim(receiptId);
    if (!cur || cur.stage === 'withdrawn') return { ok: false, retryable: false, message: '반품 접수를 찾을 수 없음(고객 철회?)' };
    if (cur.stage === 'return_done') return { ok: true, retryable: false, message: '이미 반품완료' };
    if (cur.status === 'RETURNS_UNCHECKED') {
      const r = await this.claimAction('PATCH', `${OPEN}/v4/vendors/${this.v}/returnRequests/${receiptId}/receiveConfirmation`, { vendorId: this.v, receiptId: Number(receiptId) });
      if (!r.ok) return r;
      // 빠른환불 대상이면 입고 확인만으로 환불·완료
      const after = await this.getClaim(receiptId).catch(() => null);
      if (after?.stage === 'return_done') return { ok: true, retryable: false, message: '입고 확인 → 환불 완료' };
    }
    return this.claimAction('PATCH', `${OPEN}/v4/vendors/${this.v}/returnRequests/${receiptId}/approval`, { vendorId: this.v, receiptId: Number(receiptId), cancelCount: count });
  }

  async cancelOrder(input: { marketOrderId: string; vendorItemId: string; qty: number; reason: 'stock' | 'address' | 'price' }): Promise<MarketResult> {
    const middle = { stock: 'CCTTER', address: 'CCPNER', price: 'CCPRER' }[input.reason];
    try {
      const res = await this.client.request('POST', `${OPEN}/v5/vendors/${this.v}/orders/${input.marketOrderId}/cancel`, {
        body: { orderId: Number(input.marketOrderId), vendorItemIds: [Number(input.vendorItemId)], receiptCounts: [input.qty], bigCancelCode: 'CANERR', middleCancelCode: middle, vendorId: this.v, userId: await this.getWingUserId() },
      });
      const failed: unknown[] = res?.data?.failedVendorItemIds ?? res?.data?.failedItemIds ?? [];
      const ok = String(res?.code ?? '200') === '200' && !failed.map(String).includes(String(input.vendorItemId));
      return { ok, retryable: false, message: res?.message ?? (ok ? 'OK' : '취소 실패') };
    } catch (e) {
      if (e instanceof HttpError) return { ok: false, retryable: e.status >= 500 || e.status === 429, message: e.message };
      throw e;
    }
  }

  /** 클레임 처리 응답: { code, message, data: { resultCode: SUCCESS|FAIL, resultMessage } } (이미출고는 data 안에 code가 있음) */
  private async claimAction(method: string, path: string, body: Record<string, unknown>): Promise<MarketResult> {
    try {
      const res = await this.client.request(method, path, { body });
      const rc = res?.data?.resultCode;
      const ok = rc ? rc === 'SUCCESS' : String(res?.code ?? '') === '200' || res?.code === 'SUCCESS';
      return { ok, retryable: false, message: res?.data?.resultMessage ?? res?.message ?? '' };
    } catch (e) {
      if (e instanceof HttpError) return { ok: false, retryable: e.status >= 500 || e.status === 429, message: e.message };
      throw e;
    }
  }

  // ── 상품 ──────────────────────────────────────────────────────────

  async predictCategory(productName: string): Promise<{ code: string; name: string } | null> {
    const res = await this.client.request('POST', `${OPEN}/v1/categorization/predict`, { body: { productName } });
    const d = res?.data;
    if (!d || d.autoCategorizationPredictionResultType !== 'SUCCESS' || !d.predictedCategoryId) return null;
    return { code: String(d.predictedCategoryId), name: String(d.predictedCategoryName ?? '') };
  }

  async listShippingPlaces(): Promise<ShippingPlaces> {
    const ob = await this.client.request('GET', '/v2/providers/marketplace_openapi/apis/api/v1/vendor/shipping-place/outbound', { query: { pageNum: 1, pageSize: 50 } });
    const rc = await this.client.request('GET', `/v2/providers/openapi/apis/api/v4/vendors/${this.client.vendorId}/returnShippingCenters`, { query: { pageNum: 1, pageSize: 50 } });
    return {
      outbound: (ob?.content ?? []).map((x: any) => ({ code: String(x.outboundShippingPlaceCode), name: String(x.shippingPlaceName ?? ''), usable: x.usable !== false })),
      returns: (rc?.data?.content ?? []).map((x: any) => {
        const a = x.placeAddresses?.[0] ?? {};
        return {
          code: String(x.returnCenterCode), name: String(x.shippingPlaceName ?? ''), usable: x.usable !== false,
          zip: String(a.returnZipCode ?? ''), address: String(a.returnAddress ?? ''), addressDetail: String(a.returnAddressDetail ?? ''), phone: String(a.companyContactNumber ?? ''),
        };
      }),
    };
  }

  async getCategoryMeta(code: string): Promise<CategoryMeta> {
    const res = await this.client.request('GET', `${SELLER}/meta/category-related-metas/display-category-codes/${code}`);
    const d = res?.data ?? {};
    return {
      code,
      notices: (d.noticeCategories ?? []).map((n: any) => ({
        noticeCategoryName: n.noticeCategoryName,
        details: (n.noticeCategoryDetailNames ?? []).map((x: any) => ({ name: x.noticeCategoryDetailName, required: x.required === 'MANDATORY' })),
      })),
      requiredAttributes: (d.attributes ?? []).filter((a: any) => a.required === 'MANDATORY').map((a: any) => a.attributeTypeName),
      requiredAttributeSpecs: (d.attributes ?? []).filter((a: any) => a.required === 'MANDATORY').map((a: any) => ({
        name: String(a.attributeTypeName), dataType: String(a.dataType ?? 'STRING'),
        basicUnit: a.basicUnit && a.basicUnit !== '없음' ? String(a.basicUnit) : undefined, usableUnits: (a.usableUnits ?? []).map(String),
      })),
      attributeNames: (d.attributes ?? []).map((a: any) => String(a.attributeTypeName)),
    };
  }

  async createProduct(payload: unknown): Promise<{ sellerProductId: string }> {
    const res = await this.client.request('POST', `${SELLER}/seller-products`, { body: payload });
    if (res?.code !== 'SUCCESS' || res?.data === undefined) throw new HttpError(400, `상품 생성 실패: ${res?.message ?? 'unknown'}`, res);
    return { sellerProductId: String(res.data) };
  }

  async deleteProduct(sellerProductId: string): Promise<MarketResult> {
    try {
      const res = await this.client.request('DELETE', `${SELLER}/seller-products/${sellerProductId}`);
      return { ok: res?.code === 'SUCCESS', retryable: false, message: String(res?.message ?? '') };
    } catch (e) {
      return { ok: false, retryable: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 상품 조회(GET seller-products/{id}) data 전체 */
  async getProductDetail(sellerProductId: string): Promise<Record<string, any> | null> {
    let res: any;
    for (let i = 0; ; i++) {
      try {
        res = await this.client.request('GET', `${SELLER}/seller-products/${sellerProductId}`);
        break;
      } catch (e) {
        // 실측(2026-10-14): 정상 상품도 가끔 400 {code:'DEFAULT', "오류가 발생하였습니다"} → 잠시 후 한 번 더
        const generic = e instanceof HttpError && e.status === 400 && (e.body as { code?: string } | undefined)?.code === 'DEFAULT';
        if (!generic || i >= 1) throw e;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return res?.data && typeof res.data === 'object' ? res.data : null;
  }

  /**
   * 상품 수정(승인필요, PUT seller-products): 상품 조회 JSON 전문에서 값만 바꿔 전체를 전송 → 승인 후 반영.
   * 출처: https://developers.coupang.com/ko/api/products/modify-product (확인 2026-10-14)
   */
  async updateProduct(body: Record<string, any>): Promise<MarketResult> {
    try {
      const res = await this.client.request('PUT', `${SELLER}/seller-products`, { body });
      const code = res?.data?.code ?? res?.code;
      const ok = code === 'SUCCESS' || code === '200' || code === 200;
      return { ok, retryable: false, message: String(res?.data?.message || res?.message || '') };
    } catch (e) {
      if (e instanceof HttpError) return { ok: false, retryable: e.status >= 500 || e.status === 429, message: e.message };
      throw e;
    }
  }

  async getProductStatus(sellerProductId: string): Promise<MarketProductStatus> {
    const res = await this.client.request('GET', `${SELLER}/seller-products/${sellerProductId}`);
    const d = res?.data ?? {};
    const raw = String(d.statusName ?? '');
    const status: MarketProductStatus['status'] =
      raw === '승인완료' || raw === '부분승인완료' ? 'APPROVED'
        : raw === '승인반려' || raw === '상품삭제' ? 'REJECTED'
          : raw === '임시저장' ? 'DRAFT'
            : raw === '심사중' || raw === '승인대기중' ? 'IN_REVIEW' : 'UNKNOWN';
    return {
      sellerProductId,
      status,
      rawStatus: raw,
      vendorItemIds: (d.items ?? []).map((i: any) => i.vendorItemId).filter((x: unknown) => x !== null && x !== undefined).map(String),
      items: (d.items ?? []).filter((i: any) => i.vendorItemId !== null && i.vendorItemId !== undefined).map((i: any) => ({ vendorItemId: String(i.vendorItemId), itemName: String(i.itemName ?? '') })),
    };
  }

  private async simple(method: string, path: string, query?: Record<string, string | boolean>): Promise<MarketResult> {
    try {
      const res = await this.client.request(method, path, { query });
      const ok = res?.code === 'SUCCESS' || res?.code === 200 || res?.code === '200';
      return { ok, retryable: !ok, message: res?.message ?? '' };
    } catch (e) {
      if (e instanceof HttpError) return { ok: false, retryable: e.status >= 500 || e.status === 429, message: e.message };
      throw e;
    }
  }

  updatePrice(vendorItemId: string, price: number): Promise<MarketResult> {
    // 가격은 10원 단위. 비율 제한(−50%/+100%)은 상위 가드에서 더 보수적으로 막는다.
    const p = Math.round(price / 10) * 10;
    return this.simple('PUT', `${SELLER}/vendor-items/${vendorItemId}/prices/${p}`, { forceSalePriceUpdate: false });
  }

  updateQuantity(vendorItemId: string, qty: number): Promise<MarketResult> {
    return this.simple('PUT', `${SELLER}/vendor-items/${vendorItemId}/quantities/${Math.max(0, Math.floor(qty))}`);
  }

  stopSale(vendorItemId: string): Promise<MarketResult> {
    return this.simple('PUT', `${SELLER}/vendor-items/${vendorItemId}/sales/stop`);
  }

  resumeSale(vendorItemId: string): Promise<MarketResult> {
    return this.simple('PUT', `${SELLER}/vendor-items/${vendorItemId}/sales/resume`);
  }

  /** 아이템별 수량/가격/판매상태 조회(GET vendor-items/{id}/inventories → amountInStock·salePrice·onSale) */
  async getItemSaleState(vendorItemId: string): Promise<ItemSaleState | null> {
    let res: any;
    try {
      res = await this.client.request('GET', `${SELLER}/vendor-items/${vendorItemId}/inventories`);
    } catch (e) {
      // 공식 오류(HTTP 400): "유효한 옵션이 없습니다 — 해당 옵션이 삭제되었는지 확인" → 삭제된 옵션
      if (e instanceof HttpError && e.status === 400 && /유효한 옵션이 없/.test(e.message)) return { onSale: false, quantity: null, price: null, deleted: true };
      throw e;
    }
    const d = res?.data;
    // 응답 형식이 다르면 판단하지 않음(잘못된 판매중지·재개 방지)
    if (!d || typeof d.onSale !== 'boolean') return null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return { onSale: d.onSale, quantity: num(d.amountInStock), price: num(d.salePrice) };
  }

  // ── 정산·CS ──────────────────────────────────────────────────────

  /**
   * 매출내역. 쿠팡은 조회 기간이 1개월 미만이어야 함(실측 2026-10-14: 31일 → 400 "Date range period must be less than 1 months")
   * → 최대 REVENUE_WINDOW_DAYS 일씩 나눠 조회(구간은 날짜 단위로 겹치지 않음)
   */
  async listRevenue(fromDate: string, toDate: string): Promise<RevenueLine[]> {
    const out: RevenueLine[] = [];
    for (const [from, to] of dateWindows(fromDate, toDate, REVENUE_WINDOW_DAYS)) out.push(...(await this.listRevenueWindow(from, to)));
    return out;
  }

  private async listRevenueWindow(fromDate: string, toDate: string): Promise<RevenueLine[]> {
    const out: RevenueLine[] = [];
    let token = '';
    for (let page = 0; page < 200; page++) {
      const res = await this.client.request('GET', `${OPEN}/v1/revenue-history`, {
        query: { vendorId: this.v, recognitionDateFrom: fromDate, recognitionDateTo: toDate, token: token || null, maxPerPage: 50 },
      });
      for (const r of res?.data ?? []) {
        const items: any[] = r.items ?? [];
        const delivery = money(r.deliveryFee?.settlementAmount);
        items.forEach((it, idx) => {
          out.push({
            marketOrderId: String(r.orderId),
            vendorItemId: String(it.vendorItemId),
            saleType: r.saleType === 'REFUND' ? 'REFUND' : 'SALE',
            saleAmount: money(it.saleAmount ?? it.salePrice),
            serviceFee: money(it.serviceFee),
            serviceFeeVat: money(it.serviceFeeVat),
            settlementAmount: money(it.settlementAmount),
            deliverySettlement: idx === 0 ? delivery : 0,
            recognizedAt: String(r.recognitionDate ?? r.saleDate ?? toDate),
            raw: { order: { ...r, items: undefined }, item: it },
          });
        });
      }
      if (!res?.hasNext || !res?.nextToken) break;
      token = String(res.nextToken);
    }
    return out;
  }

  async listInquiries(from: Date, to: Date): Promise<MarketInquiry[]> {
    const out: MarketInquiry[] = [];
    // 조회 구간 7일 이하
    for (let page = 1; page <= 20; page++) {
      const res = await this.client.request('GET', `${OPEN}/v5/vendors/${this.v}/onlineInquiries`, {
        query: { vendorId: this.v, answeredType: 'NOANSWER', inquiryStartAt: kstDate(from), inquiryEndAt: kstDate(to), pageNum: page, pageSize: 50 },
      });
      for (const c of res?.data?.content ?? []) {
        out.push({
          inquiryId: String(c.inquiryId),
          kind: 'product',
          vendorItemId: c.vendorItemId ? String(c.vendorItemId) : undefined,
          content: String(c.content ?? ''),
          askedAt: new Date(c.inquiryAt ?? Date.now()),
          answered: (c.commentDtoList ?? []).length > 0,
        });
      }
      const p = res?.data?.pagination;
      if (!p || p.currentPage >= p.totalPages) break;
    }
    // 쿠팡 고객센터 이관 문의(실측 2026-10-14: v4 callCenterInquiries 200 OK) — 쿠팡 상담원이 넘긴 급한 문의
    for (let page = 1; page <= 10; page++) {
      const res = await this.client.request('GET', `${OPEN}/v4/vendors/${this.v}/callCenterInquiries`, {
        query: { vendorId: this.v, partnerCounselingStatus: 'NO_ANSWER', inquiryStartAt: kstDate(from), inquiryEndAt: kstDate(to), pageNum: page, pageSize: 30 },
      });
      for (const c of res?.data?.content ?? []) {
        out.push({
          inquiryId: String(c.inquiryId),
          kind: 'callcenter',
          vendorItemId: c.vendorItemId ? String(c.vendorItemId) : undefined,
          content: String(c.content ?? c.inquiryContent ?? ''),
          askedAt: new Date(c.inquiryAt ?? c.createdAt ?? Date.now()),
          answered: false,
        });
      }
      const p = res?.data?.pagination;
      if (!p || p.currentPage >= p.totalPages) break;
    }
    return out;
  }

  async replyInquiry(inq: { inquiryId: string; kind: 'product' | 'callcenter' }, text: string): Promise<MarketResult> {
    const path = inq.kind === 'product'
      ? `${OPEN}/v4/vendors/${this.v}/onlineInquiries/${inq.inquiryId}/replies`
      : `${OPEN}/v4/vendors/${this.v}/callCenterInquiries/${inq.inquiryId}/replies`;
    try {
      const res = await this.client.request('POST', path, { body: { content: text, vendorId: this.v, replyBy: await this.getWingUserId() } });
      return { ok: res?.code === 200 || res?.code === 'SUCCESS' || res?.code === '200', retryable: false, message: res?.message ?? '' };
    } catch (e) {
      if (e instanceof HttpError) return { ok: false, retryable: e.status >= 500, message: e.message };
      throw e;
    }
  }
}

function parseSheet(sheet: any): MarketOrderLine[] {
  const r = sheet.receiver ?? {};
  const items: any[] = sheet.orderItems ?? [];
  return items.map((it) => ({
    marketOrderId: String(sheet.orderId),
    shipmentBoxId: String(sheet.shipmentBoxId),
    vendorItemId: String(it.vendorItemId),
    sellerProductId: it.sellerProductId ? String(it.sellerProductId) : undefined,
    itemName: String(it.vendorItemName ?? it.sellerProductName ?? ''),
    qty: Number(it.shippingCount ?? 1),
    paidAmount: money(it.orderPrice) - money(it.discountPrice) || money(it.orderPrice),
    orderedAt: new Date(sheet.orderedAt ?? sheet.paidAt ?? Date.now()),
    status: (sheet.status ?? 'UNKNOWN') as MarketOrderStatus,
    receiver: {
      name: String(r.name ?? ''),
      phone: String(r.receiverNumber ?? r.safeNumber ?? ''),
      addr1: String(r.addr1 ?? ''),
      addr2: String(r.addr2 ?? ''),
      zip: String(r.postCode ?? ''),
    },
    deliveryMessage: sheet.parcelPrintMessage || undefined,
    shipBy: it.estimatedShippingDate || undefined,
    canceled: !!it.canceled,
    invoiceNumber: sheet.invoiceNumber || undefined,
  }));
}


/** 반품·취소 접수 → 주문 줄(옵션)별 클레임. 단계는 접수 상태 + 옵션 출고 상태로 판단 */
export function parseReturnReceipt(r: any): MarketClaim[] {
  const items: any[] = r.returnItems?.length ? r.returnItems : [{}];
  const status = String(r.receiptStatus ?? '');
  const cancelType = r.receiptType === 'CANCEL' || r.receiptType === '취소';
  return items.map((it) => {
    const release = String(it.releaseStatus ?? '');
    let stage: MarketClaim['stage'];
    if (cancelType) stage = 'cancelled';
    else if (status === 'RELEASE_STOP_UNCHECKED') stage = 'stop_requested';
    else if (status === 'RETURNS_UNCHECKED') stage = release === 'N' ? 'stop_requested' : 'return_requested';
    else if (status === 'VENDOR_WAREHOUSE_CONFIRM') stage = 'return_collected';
    else if (status === 'REQUEST_COUPANG_CHECK') stage = 'coupang_check';
    else if (status === 'RETURNS_COMPLETED') stage = release === 'S' || /출고중지/.test(String(r.releaseStopStatus ?? '')) ? 'cancelled' : 'return_done';
    return {
      receiptId: String(r.receiptId),
      marketOrderId: String(r.orderId),
      vendorItemId: it.vendorItemId ? String(it.vendorItemId) : undefined,
      type: cancelType ? 'CANCEL' : 'RETURN',
      status,
      stage,
      count: typeof it.cancelCount === 'number' ? it.cancelCount : typeof r.cancelCountSum === 'number' ? r.cancelCountSum : undefined,
      shipmentBoxId: it.shipmentBoxId ? String(it.shipmentBoxId) : undefined,
      faultBy: r.faultByType || undefined,
      returnShippingCharge: r.returnShippingCharge == null ? undefined : money(r.returnShippingCharge),
      reason: [r.cancelReasonCategory1, r.cancelReasonCategory2, r.cancelReason].filter(Boolean).join(' / ') || String(r.reasonCodeText ?? ''),
      requestedAt: new Date(r.createdAt ? `${String(r.createdAt).slice(0, 19)}+09:00` : Date.now()),
    };
  });
}

/** 교환 접수 → 클레임(원주문 옵션 기준) */
export function parseExchange(r: any): MarketClaim[] {
  const items: any[] = r.exchangeItemDtoV1s?.length ? r.exchangeItemDtoV1s : r.exchangeItems?.length ? r.exchangeItems : [{}];
  const status = String(r.exchangeStatus ?? r.status ?? '');
  const stage: MarketClaim['stage'] = status === 'SUCCESS' ? 'exchange_done' : status === 'REJECT' || status === 'CANCEL' ? 'withdrawn' : 'exchange_open';
  return items.map((it) => {
    const vid = it.originalVendorItemId ?? it.orderItemId ?? it.vendorItemId ?? r.vendorItemId;
    return {
      receiptId: String(r.exchangeId ?? r.receiptId ?? ''),
      marketOrderId: String(r.orderId),
      vendorItemId: vid ? String(vid) : undefined,
      type: 'EXCHANGE',
      status,
      stage,
      count: typeof it.quantity === 'number' ? it.quantity : undefined,
      shipmentBoxId: it.originalShipmentBoxId ? String(it.originalShipmentBoxId) : undefined,
      faultBy: r.faultType || r.faultByType || undefined,
      reason: [r.reasonCodeText ?? r.reasonCode, r.reasonEtcDetail].filter(Boolean).join(' / '),
      requestedAt: new Date(r.createdAt ? `${String(r.createdAt).slice(0, 19)}+09:00` : Date.now()),
    };
  });
}
