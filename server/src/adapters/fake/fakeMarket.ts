import type {
  CategoryMeta, InvoiceInput, MarketClaim, MarketInquiry, MarketOrderLine, MarketOrderStatus, MarketPort,
  ItemSaleState, MarketProductStatus, MarketResult, RevenueLine,
} from '../../ports/market.js';

/**
 * 메모리 기반 가짜 쿠팡. 키 없이 전체 흐름을 테스트·시연한다.
 * 테스트 코드에서 seedOrder / deliver / addRevenue 등으로 상황을 만든다.
 */
export class FakeMarket implements MarketPort {
  /** 판매채널 이름(테스트에서 스마트스토어 흉내 시 'naver') */
  constructor(readonly name = 'coupang', readonly label = name === 'naver' ? '스마트스토어' : '쿠팡') {}
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
    // 분리배송이면 해당 상품만, 아니면 묶음 전체가 대상
    const target = input.splitShipping ? lines.filter((l) => l.vendorItemId === input.vendorItemId) : lines;
    if (!target.length || target.some((l) => l.status !== 'INSTRUCT')) return { ok: false, retryable: false, message: 'INVALID_STATUS' };
    if (!/^\d{8,14}$/.test(input.trackingNo)) return { ok: false, retryable: true, message: 'INVALID_INVOICE_NUMBER' };
    this.invoices.push(input);
    target.forEach((l) => {
      l.status = 'DEPARTURE';
      l.invoiceNumber = input.trackingNo;
    });
    return { ok: true, retryable: false, message: 'OK' };
  }

  /** 테스트: 송장 수정 기록 */
  invoiceUpdates: InvoiceInput[] = [];
  async updateInvoice(input: InvoiceInput): Promise<MarketResult> {
    this.maybeFail('updateInvoice');
    const lines = this.orders.get(input.shipmentBoxId);
    if (!lines?.some((l) => ['DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY', 'NONE_TRACKING'].includes(l.status))) return { ok: false, retryable: false, message: 'INVALID_STATUS' };
    this.invoiceUpdates.push(input);
    lines.forEach((l) => (l.invoiceNumber = input.trackingNo));
    return { ok: true, retryable: false, message: 'OK' };
  }

  async listClaims(from: Date, to: Date): Promise<MarketClaim[]> {
    this.maybeFail('listClaims');
    return this.claims.filter((c) => c.requestedAt >= from && c.requestedAt <= to).map((c) => ({ ...c }));
  }

  /** 테스트: 클레임 처리 기록 */
  claimActions: Array<{ action: string; receiptId: string; detail?: unknown }> = [];

  /** 테스트: 고객 클레임 상황 만들기(쿠팡 실제 흐름) */
  claim(c: Partial<MarketClaim> & { receiptId: string; marketOrderId: string; vendorItemId: string; type: MarketClaim['type']; stage: NonNullable<MarketClaim['stage']> }): MarketClaim {
    const full: MarketClaim = { status: c.stage, reason: '단순변심', requestedAt: new Date(), count: 1, ...c };
    this.claims = this.claims.filter((x) => x.receiptId !== c.receiptId);
    this.claims.push(full);
    return full;
  }

  setClaimStage(receiptId: string, stage: NonNullable<MarketClaim['stage']>): void {
    for (const c of this.claims) if (c.receiptId === receiptId) c.stage = stage;
  }

  async getClaim(receiptId: string): Promise<MarketClaim | null> {
    this.maybeFail('getClaim');
    const c = this.claims.find((x) => x.receiptId === receiptId);
    return c ? { ...c } : null;
  }

  private claimStep(action: string, receiptId: string, need: Array<NonNullable<MarketClaim['stage']>>, next: NonNullable<MarketClaim['stage']>, detail?: unknown): MarketResult {
    this.maybeFail(action);
    const c = this.claims.find((x) => x.receiptId === receiptId);
    if (!c) return { ok: false, retryable: false, message: '취소반품접수내역이 존재하지 않습니다.' };
    // 예전 형식(stage 없이 type·status)도 쿠팡처럼 판단
    c.stage ??= c.status === 'RU' ? 'stop_requested' : c.type === 'CANCEL' ? 'cancelled' : c.type === 'EXCHANGE' ? 'exchange_open' : c.status === 'CC' ? 'return_done' : 'return_requested';
    if (!need.includes(c.stage)) return { ok: false, retryable: false, message: `invalid stage ${c.stage}` };
    c.stage = next;
    this.claimActions.push({ action, receiptId, detail });
    return { ok: true, retryable: false, message: 'SUCCESS' };
  }

  async stopShipment(receiptId: string, count: number): Promise<MarketResult> {
    const r = this.claimStep('stopShipment', receiptId, ['stop_requested'], 'cancelled', { count });
    if (r.ok) {
      const c = this.claims.find((x) => x.receiptId === receiptId)!;
      for (const lines of this.orders.values()) for (const l of lines) if (l.marketOrderId === c.marketOrderId && l.vendorItemId === c.vendorItemId) l.status = 'CANCELED' as any;
    }
    return r;
  }

  async markShippedForClaim(receiptId: string, courierCode: string, trackingNo: string): Promise<MarketResult> {
    return this.claimStep('markShippedForClaim', receiptId, ['stop_requested'], 'return_requested', { courierCode, trackingNo });
  }

  async confirmReturn(receiptId: string, count: number): Promise<MarketResult> {
    return this.claimStep('confirmReturn', receiptId, ['return_requested', 'return_collected'], 'return_done', { count });
  }

  sellerCancels: Array<{ marketOrderId: string; vendorItemId: string; qty: number; reason: string }> = [];
  async cancelOrder(input: { marketOrderId: string; vendorItemId: string; qty: number; reason: 'stock' | 'address' | 'price'; shipmentBoxId?: string }): Promise<MarketResult> {
    this.maybeFail('cancelOrder');
    const lines = [...this.orders.values()].flat().filter((l) => l.marketOrderId === input.marketOrderId && l.vendorItemId === input.vendorItemId);
    if (!lines.length || lines.some((l) => !['ACCEPT', 'INSTRUCT'].includes(l.status))) return { ok: false, retryable: false, message: '결제완료·상품준비중 상태가 아님' };
    for (const l of lines) l.status = 'CANCELED' as any;
    this.sellerCancels.push(input);
    return { ok: true, retryable: false, message: 'OK' };
  }

  async predictCategory(productName: string): Promise<{ code: string; name: string } | null> {
    this.maybeFail('predictCategory');
    return productName ? { code: '63950', name: '생활용품>수납/정리' } : null;
  }

  shippingPlaces = {
    outbound: [{ code: '10000001', name: '출고지', usable: true }],
    returns: [{ code: '2000000001', name: '반품지', usable: true, zip: '04524', address: '서울특별시 중구 세종대로 110', addressDetail: '101호', phone: '010-1234-5678' }],
  };
  async listShippingPlaces() {
    return this.shippingPlaces;
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
    // 스마트스토어는 원상품번호(숫자)
    const id = this.name === 'naver' ? String(900000 + ++this.seq) : `SP${++this.seq}`;
    this.products.set(id, { payload, status: 'IN_REVIEW', vendorItemIds: [] });
    return { sellerProductId: id };
  }

  async deleteProduct(sellerProductId: string): Promise<MarketResult> {
    return { ok: this.products.delete(sellerProductId), retryable: false, message: '' };
  }

  /** 테스트: 심사 승인 처리 */
  /** 승인: 옵션마다 옵션ID 발급. 반환값은 첫 옵션(1개) ID */
  /** 테스트: 상품 수정 요청 기록 */
  updates: Array<Record<string, any>> = [];

  async getProductDetail(sellerProductId: string): Promise<Record<string, any> | null> {
    this.maybeFail('getProductDetail');
    const p = this.products.get(sellerProductId);
    if (!p) return null;
    const statusName = { APPROVED: '승인완료', IN_REVIEW: '심사중', REJECTED: '승인반려', DRAFT: '임시저장', UNKNOWN: '' }[p.status];
    const items = (p.payload?.items ?? []).map((it: any, i: number) => ({ ...structuredClone(it), sellerProductItemId: 9000 + i, vendorItemId: p.vendorItemIds[i] ?? null }));
    return { ...structuredClone(p.payload ?? {}), sellerProductId, statusName, items };
  }

  async updateProduct(body: Record<string, any>): Promise<MarketResult> {
    this.maybeFail('updateProduct');
    const p = this.products.get(String(body.sellerProductId));
    if (!p) return { ok: false, retryable: false, message: '상품 없음' };
    this.updates.push(structuredClone(body));
    const { sellerProductId: _id, statusName: _s, ...rest } = body;
    p.payload = { ...rest, items: (body.items ?? []).map(({ sellerProductItemId: _a, vendorItemId: _b, ...it }: any) => it) };
    p.status = 'IN_REVIEW';
    return { ok: true, retryable: false, message: 'SUCCESS' };
  }

  approve(sellerProductId: string): string {
    const p = this.products.get(sellerProductId);
    if (!p) throw new Error('no product');
    p.status = 'APPROVED';
    // 수정 후 재승인: 옵션ID는 그대로
    if (p.vendorItemIds.length && p.vendorItemIds.length === (p.payload?.items?.length ?? 1)) return p.vendorItemIds[0]!;
    if (p.payload?.originProduct) {
      // 스마트스토어 형식: 조합형 옵션(판매자 관리코드) 또는 단일 상품
      const op = p.payload.originProduct;
      const combos: any[] = op.detailAttribute?.optionInfo?.optionCombinations ?? [];
      const rows = combos.length ? combos : [{ sellerManagerCode: op.detailAttribute?.sellerCodeInfo?.sellerManagementCode, price: 0, stockQuantity: op.stockQuantity, optionName1: '' }];
      p.vendorItemIds = rows.map((c) => {
        const code = String(c.sellerManagerCode ?? '').replace(/^NVI/, '');
        const vi = `NV${sellerProductId}:${code || '0'}`;
        this.items.set(vi, { price: op.salePrice + (c.price ?? 0), qty: c.stockQuantity ?? 0, onSale: true });
        this.itemNames.set(vi, [c.optionName1, c.optionName2].filter(Boolean).join(' '));
        this.sellerCodes.set(vi, String(c.sellerManagerCode ?? ''));
        return vi;
      });
      return p.vendorItemIds[0]!;
    }
    const payloadItems: any[] = p.payload?.items?.length ? p.payload.items : [{}];
    p.vendorItemIds = payloadItems.map((it) => {
      const vi = `VI${++this.seq}`;
      this.items.set(vi, { price: it.salePrice ?? 0, qty: it.maximumBuyCount ?? 0, onSale: true });
      this.itemNames.set(vi, String(it.itemName ?? ''));
      return vi;
    });
    return p.vendorItemIds[0]!;
  }
  itemNames = new Map<string, string>();
  sellerCodes = new Map<string, string>();

  async getProductStatus(sellerProductId: string): Promise<MarketProductStatus> {
    this.maybeFail('getProductStatus');
    if (this.deletedInWing.has(sellerProductId)) return { sellerProductId, status: 'REJECTED', rawStatus: '상품삭제', vendorItemIds: [] };
    const p = this.products.get(sellerProductId);
    if (!p) return { sellerProductId, status: 'UNKNOWN', rawStatus: '', vendorItemIds: [] };
    if (this.autoApprove && p.status === 'IN_REVIEW') this.approve(sellerProductId);
    return { sellerProductId, status: p.status, rawStatus: p.status, vendorItemIds: p.vendorItemIds, items: p.vendorItemIds.map((v) => ({ vendorItemId: v, itemName: this.itemNames.get(v) ?? '', ...(this.sellerCodes.has(v) ? { sellerCode: this.sellerCodes.get(v) } : {}) })) };
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
  /** 테스트: Wing에서 상품을 삭제(옵션 조회는 '삭제됨', 상품 조회는 '상품삭제') */
  deletedInWing = new Set<string>();
  deleteInWing(sellerProductId: string, vendorItemIds: string[]): void {
    this.deletedInWing.add(sellerProductId);
    for (const v of vendorItemIds) this.deletedInWing.add(v);
  }

  async getItemSaleState(id: string): Promise<ItemSaleState | null> {
    this.maybeFail('getItemSaleState');
    if (this.deletedInWing.has(id)) return { onSale: false, quantity: null, price: null, deleted: true };
    const it = this.items.get(id);
    return it ? { onSale: it.onSale, quantity: it.qty, price: it.price } : null;
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
