import type {
  CategoryMeta, InvoiceInput, MarketClaim, MarketInquiry, MarketOrderLine, MarketOrderStatus, MarketPort,
  MarketProductStatus, MarketResult, RevenueLine, ShippingPlaces,
} from '../../ports/market.js';
import { HttpError, kstDate, kstIsoMinute } from '../../lib/util.js';
import { type CoupangClient, money } from './client.js';

/**
 * 쿠팡 OPEN API 어댑터. 엔드포인트 출처: https://developers.coupang.com/ko/api (확인 2026-10-13)
 * 사양 변경 시 이 파일만 수정한다.
 */
const SELLER = '/v2/providers/seller_api/apis/api/v1/marketplace';
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
            splitShipping: false,
            preSplitShipped: false,
            estimatedShippingDate: '',
          },
        ],
      },
    });
    const r = res?.data?.responseList?.[0];
    if (!r) return { ok: res?.data?.responseCode === 0, retryable: true, message: res?.data?.responseMessage ?? 'no result' };
    return { ok: !!r.succeed, retryable: !!r.retryRequired, message: r.resultMessage ?? r.resultCode ?? '' };
  }

  async listClaims(from: Date, to: Date): Promise<MarketClaim[]> {
    const out: MarketClaim[] = [];
    const fmt = (d: Date) => kstIsoMinute(d).slice(0, 16);
    for (const cancelType of ['RETURN', 'CANCEL'] as const) {
      const res = await this.client.request('GET', `${OPEN}/v6/vendors/${this.v}/returnRequests`, {
        query: { searchType: 'timeFrame', createdAtFrom: fmt(from), createdAtTo: fmt(to), cancelType },
      });
      for (const r of res?.data ?? []) {
        const items: any[] = r.returnItems ?? [{}];
        for (const it of items) {
          out.push({
            receiptId: String(r.receiptId),
            marketOrderId: String(r.orderId),
            vendorItemId: it.vendorItemId ? String(it.vendorItemId) : undefined,
            type: r.receiptType === 'CANCEL' ? 'CANCEL' : 'RETURN',
            status: String(r.receiptStatus ?? ''),
            reason: [r.cancelReasonCategory1, r.cancelReason].filter(Boolean).join(' / '),
            requestedAt: new Date(r.createdAt ? `${r.createdAt}+09:00` : Date.now()),
          });
        }
      }
    }
    return out;
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

  // ── 정산·CS ──────────────────────────────────────────────────────

  async listRevenue(fromDate: string, toDate: string): Promise<RevenueLine[]> {
    const out: RevenueLine[] = [];
    let token = '';
    for (let page = 0; page < 200; page++) {
      const res = await this.client.request('GET', `${OPEN}/v1/revenue-history`, {
        query: { vendorId: this.v, recognitionDateFrom: fromDate, recognitionDateTo: toDate, token, maxPerPage: 50 },
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
