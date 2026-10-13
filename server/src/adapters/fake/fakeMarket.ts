import type {
  CategoryMeta, InvoiceInput, MarketClaim, MarketInquiry, MarketOrderLine, MarketOrderStatus, MarketPort,
  MarketProductStatus, MarketResult, RevenueLine,
} from '../../ports/market.js';

/**
 * 메모리 기반 가짜 쿠팡. 키 없이 전체 흐름을 테스트·시연한다.
 * 테스트 코드에서 seedOrder / deliver / addRevenue 등으로 상황을 만든다.
 */
export class FakeMarket implements MarketPort {
  readonly name = 'coupang';
  orders = new Map<string, MarketOrderLine[]>(); // shipmentBoxId → lines
  products = new Map<string, { payload: any; status: MarketProductStatus['status']; vendorItemIds: string[] }>();
  items = new Map<string, { price: number; qty: number; onSale: boolean }>();
  invoices: InvoiceInput[] = [];
  claims: MarketClaim[] = [];
  revenue: RevenueLine[] = [];
  inquiries: MarketInquiry[] = [];
  replies: Array<{ inquiryId: string; text: string }> = [];
  calls: string[] = [];
  /** 실패 주입: 메서드명 → 남은 실패 횟수 */
  failNext = new Map<string, number>();
  /** 체험 모드: 상품 상태 조회 시 자동 승인 */
  autoApprove = false;
  private seq = 1000;

  private maybeFail(name: string): void {
    this.calls.push(name);
    const n = this.failNext.get(name) ?? 0;
    if (n > 0) {
      this.failNext.set(name, n - 1);
      throw new Error(`fake ${name} failure`);
    }
  }

  seedOrder(line: Partial<MarketOrderLine> & { vendorItemId: string }): MarketOrderLine {
    const id = String(++this.seq);
    const full: MarketOrderLine = {
      marketOrderId: line.marketOrderId ?? `O${id}`,
      shipmentBoxId: line.shipmentBoxId ?? `B${id}`,
      vendorItemId: line.vendorItemId,
      itemName: line.itemName ?? '테스트 상품',
      qty: line.qty ?? 1,
      paidAmount: line.paidAmount ?? 30000,
      orderedAt: line.orderedAt ?? new Date(),
      status: line.status ?? 'ACCEPT',
      receiver: line.receiver ?? { name: '홍길동', phone: '010-1234-5678', addr1: '서울특별시 중구 세종대로 110', addr2: '101호', zip: '04524' },
      deliveryMessage: line.deliveryMessage ?? '문 앞에 놓아주세요',
      shipBy: line.shipBy,
    };
    const list = this.orders.get(full.shipmentBoxId) ?? [];
    list.push(full);
    this.orders.set(full.shipmentBoxId, list);
    return full;
  }

  setStatus(shipmentBoxId: string, status: MarketOrderStatus): void {
    for (const l of this.orders.get(shipmentBoxId) ?? []) l.status = status;
  }

  async listOrders(from: Date, to: Date, status: MarketOrderStatus): Promise<MarketOrderLine[]> {
    this.maybeFail('listOrders');
    return [...this.orders.values()].flat().filter((l) => l.status === status && l.orderedAt >= from && l.orderedAt <= to).map((l) => structuredClone(l));
  }

  async getOrderLines(shipmentBoxId: string): Promise<MarketOrderLine[]> {
    this.maybeFail('getOrderLines');
    return (this.orders.get(shipmentBoxId) ?? []).map((l) => structuredClone(l));
  }

  async acknowledge(ids: string[]): Promise<Record<string, MarketResult>> {
    this.maybeFail('acknowledge');
    const out: Record<string, MarketResult> = {};
    for (const id of ids) {
      const lines = this.orders.get(id);
      if (!lines) out[id] = { ok: false, retryable: false, message: 'not found' };
      else if (lines.some((l) => l.status !== 'ACCEPT' && l.status !== 'INSTRUCT')) out[id] = { ok: false, retryable: false, message: 'invalid status' };
      else {
        lines.forEach((l) => (l.status = 'INSTRUCT'));
        out[id] = { ok: true, retryable: false, message: 'OK' };
      }
    }
    return out;
  }

  async uploadInvoice(input: InvoiceInput): Promise<MarketResult> {
    this.maybeFail('uploadInvoice');
    const lines = this.orders.get(input.shipmentBoxId);
    if (!lines) return { ok: false, retryable: false, message: 'NOT_FOUND_SHIPMENT_BOX' };
    if (lines.some((l) => l.status !== 'INSTRUCT')) return { ok: false, retryable: false, message: 'INVALID_STATUS' };
    if (!/^\d{8,14}$/.test(input.trackingNo)) return { ok: false, retryable: true, message: 'INVALID_INVOICE_NUMBER' };
    this.invoices.push(input);
    lines.forEach((l) => {
      l.status = 'DEPARTURE';
      l.invoiceNumber = input.trackingNo;
    });
    return { ok: true, retryable: false, message: 'OK' };
  }

  async listClaims(from: Date, to: Date): Promise<MarketClaim[]> {
    this.maybeFail('listClaims');
    return this.claims.filter((c) => c.requestedAt >= from && c.requestedAt <= to);
  }

  async predictCategory(productName: string): Promise<{ code: string; name: string } | null> {
    this.maybeFail('predictCategory');
    return productName ? { code: '63950', name: '생활용품>수납/정리' } : null;
  }

  async getCategoryMeta(code: string): Promise<CategoryMeta> {
    return {
      code,
      notices: [
        {
          noticeCategoryName: '기타 재화',
          details: [
            { name: '품명 및 모델명', required: true },
            { name: '인증/허가 사항', required: true },
            { name: '제조국(원산지)', required: true },
            { name: '제조자(수입자)', required: true },
            { name: '소비자상담 관련 전화번호', required: true },
          ],
        },
      ],
      requiredAttributes: [],
    };
  }

  async createProduct(payload: any): Promise<{ sellerProductId: string }> {
    this.maybeFail('createProduct');
    const id = `SP${++this.seq}`;
    this.products.set(id, { payload, status: 'IN_REVIEW', vendorItemIds: [] });
    return { sellerProductId: id };
  }

  /** 테스트: 심사 승인 처리 */
  approve(sellerProductId: string): string {
    const p = this.products.get(sellerProductId);
    if (!p) throw new Error('no product');
    const vi = `VI${++this.seq}`;
    p.status = 'APPROVED';
    p.vendorItemIds = [vi];
    this.items.set(vi, { price: p.payload?.items?.[0]?.salePrice ?? 0, qty: p.payload?.items?.[0]?.maximumBuyCount ?? 0, onSale: true });
    return vi;
  }

  async getProductStatus(sellerProductId: string): Promise<MarketProductStatus> {
    const p = this.products.get(sellerProductId);
    if (!p) return { sellerProductId, status: 'UNKNOWN', rawStatus: '', vendorItemIds: [] };
    if (this.autoApprove && p.status === 'IN_REVIEW') this.approve(sellerProductId);
    return { sellerProductId, status: p.status, rawStatus: p.status, vendorItemIds: p.vendorItemIds };
  }

  private item(id: string) {
    let it = this.items.get(id);
    if (!it) {
      it = { price: 0, qty: 0, onSale: true };
      this.items.set(id, it);
    }
    return it;
  }

  async updatePrice(id: string, price: number): Promise<MarketResult> {
    this.maybeFail('updatePrice');
    this.item(id).price = price;
    return { ok: true, retryable: false, message: 'OK' };
  }
  async updateQuantity(id: string, qty: number): Promise<MarketResult> {
    this.item(id).qty = qty;
    return { ok: true, retryable: false, message: 'OK' };
  }
  async stopSale(id: string): Promise<MarketResult> {
    this.item(id).onSale = false;
    return { ok: true, retryable: false, message: 'OK' };
  }
  async resumeSale(id: string): Promise<MarketResult> {
    this.item(id).onSale = true;
    return { ok: true, retryable: false, message: 'OK' };
  }

  async listRevenue(fromDate: string, toDate: string): Promise<RevenueLine[]> {
    return this.revenue.filter((r) => r.recognizedAt >= fromDate && r.recognizedAt <= toDate);
  }

  async listInquiries(from: Date, to: Date): Promise<MarketInquiry[]> {
    return this.inquiries.filter((i) => !i.answered && i.askedAt >= from && i.askedAt <= to);
  }

  async replyInquiry(inq: { inquiryId: string }, text: string): Promise<MarketResult> {
    this.replies.push({ inquiryId: inq.inquiryId, text });
    const q = this.inquiries.find((i) => i.inquiryId === inq.inquiryId);
    if (q) q.answered = true;
    return { ok: true, retryable: false, message: 'OK' };
  }
}
