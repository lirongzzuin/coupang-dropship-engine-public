import type {
  SourceAdapter, SourceOrderRequest, SourceOrderResult, SourceProductDetail, SourceProductSummary, SourceTracking,
} from '../../ports/source.js';

/** 테스트·데모용 공급처. apiOrder 여부를 생성자에서 정해 두 가지 흐름(API/작업함)을 모두 검증한다. */
export class MockSource implements SourceAdapter {
  readonly displayName: string;
  readonly capabilities: { search: boolean; detail: boolean; apiOrder: boolean; apiTracking: boolean };
  products = new Map<string, SourceProductDetail>();
  orders = new Map<string, { req: SourceOrderRequest; tracking?: SourceTracking }>();
  failNext = new Map<string, number>();
  needsPayment = false;
  private seq = 0;

  constructor(readonly id = 'mock', opts: { apiOrder?: boolean } = {}) {
    this.displayName = `Mock(${id})`;
    const api = opts.apiOrder ?? true;
    this.capabilities = { search: true, detail: true, apiOrder: api, apiTracking: api };
  }

  private maybeFail(name: string): void {
    const n = this.failNext.get(name) ?? 0;
    if (n > 0) {
      this.failNext.set(name, n - 1);
      throw new Error(`mock ${name} failure`);
    }
  }

  add(p: Partial<SourceProductDetail> & { sourceItemId: string; title: string; price: number }): SourceProductDetail {
    const full: SourceProductDetail = {
      url: `https://mock.example/${p.sourceItemId}`,
      imageUrl: `https://mock.example/${p.sourceItemId}.jpg`,
      shippingFee: 3000,
      status: 'active',
      stock: 100,
      imageReuseAllowed: true,
      images: [`https://mock.example/${p.sourceItemId}.jpg`],
      taxInvoice: true,
      prepDays: 1,
      categoryPath: '생활용품>수납/정리',
      notice: { type: '기타 재화', items: [{ name: '품명 및 모델명', value: p.title }, { name: '제조국(원산지)', value: '대한민국' }] },
      kc: { certified: false, exempt: false },
      ...p,
    };
    this.products.set(full.sourceItemId, full);
    return full;
  }

  async search(keyword: string, opts: { limit?: number; minPrice?: number; maxPrice?: number } = {}): Promise<SourceProductSummary[]> {
    this.maybeFail('search');
    return [...this.products.values()]
      .filter((p) => keyword.split(/\s+/).filter(Boolean).every((w) => p.title.includes(w)) && p.status === 'active')
      .filter((p) => (!opts.minPrice || p.price >= opts.minPrice) && (!opts.maxPrice || p.price <= opts.maxPrice))
      .slice(0, opts.limit ?? 20)
      .map(({ sourceItemId, title, url, imageUrl, price, shippingFee }) => ({ sourceItemId, title, url, imageUrl, price, shippingFee }));
  }

  async getProduct(id: string): Promise<SourceProductDetail | null> {
    this.maybeFail('getProduct');
    const p = this.products.get(id);
    return p ? structuredClone(p) : null;
  }

  async placeOrder(req: SourceOrderRequest): Promise<SourceOrderResult> {
    this.maybeFail('placeOrder');
    for (const [id, o] of this.orders) if (o.req.idempotencyKey === req.idempotencyKey) {
      const p = this.products.get(req.sourceItemId)!;
      return { sourceOrderId: id, cost: p.price * req.qty, shippingCost: p.shippingFee, needsPayment: this.needsPayment };
    }
    const p = this.products.get(req.sourceItemId);
    if (!p || p.status !== 'active') throw new Error('품절');
    const id = `MO${++this.seq}`;
    this.orders.set(id, { req });
    return { sourceOrderId: id, cost: p.price * req.qty, shippingCost: p.shippingFee, needsPayment: this.needsPayment };
  }

  /** 테스트: 공급처가 송장을 등록 */
  ship(sourceOrderId: string, trackingNo = '123456789012', courierName = 'CJ대한통운'): void {
    const o = this.orders.get(sourceOrderId);
    if (!o) throw new Error('no order');
    o.tracking = { courierName, trackingNo };
  }

  async getTracking(sourceOrderId: string): Promise<SourceTracking | null> {
    return this.orders.get(sourceOrderId)?.tracking ?? null;
  }
}
